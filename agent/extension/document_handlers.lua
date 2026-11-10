-- Document Handlers: everything the bridge can ask of Aseprite, with no
-- transport. call(method, params) answers one protocol request and returns
-- the result, plus raw bytes for requests the protocol marks binary.
--
--   local DocumentHandlers = dofile("document_handlers.lua")
--   local H = DocumentHandlers.new{ chunkDir = plugin.path, protocol = P }
--   local result, bytes = H.call("snapshot", { frame = 1 })
--
-- The bridge connection calls H.call; tests call it (or the named pieces
-- below) directly in Aseprite batch mode.
--
-- Operation policy: protocol.json gives every request a kind. A "read"
-- leaves the document alone. A "write" or "scoped-write" changes it, and
-- H.call runs every write the same way: it needs an active sprite (unless
-- the request says needsSprite: false, e.g. one that creates a sprite), its
-- step is captured (step_capture.lua), and for a sub-agent's scope the
-- scope guard (scope_guard.lua) undoes a "scoped-write" that changed
-- something outside the scope, while a "write" the guard can't check is
-- refused.
--
-- Handlers live here (core requests) and in area files that register into
-- the same table: handlers_check.lua, handlers_color.lua, handlers_sprite.lua.
-- How the document is described (layer ids, State block, aseprite:// URIs)
-- is the Document View (document_view.lua).

local M = {}

---------------------------------------------------------------------------
-- Operation policy (from protocol.json)
---------------------------------------------------------------------------

M.KINDS = { read = true, write = true, ["scoped-write"] = true }

-- True for requests that change the document.
function M.isWrite(spec)
  return spec.kind == "write" or spec.kind == "scoped-write"
end

-- Whether a request needs an active sprite: writes do unless they say
-- needsSprite: false; reads only when they say needsSprite: true.
function M.needsSprite(spec)
  if spec.needsSprite ~= nil then return spec.needsSprite end
  return M.isWrite(spec)
end

-- The set of write requests in a protocol: { name = true }.
function M.writes(protocol)
  local out = {}
  for name, spec in pairs(protocol.requests) do
    if M.isWrite(spec) then out[name] = true end
  end
  return out
end

-- Every request has a known kind; an unknown one is a protocol.json mistake.
local function checkKinds(protocol)
  for name, spec in pairs(protocol.requests) do
    if not M.KINDS[spec.kind] then
      error("protocol.json: request " .. name .. " has no valid kind (read, write or scoped-write): " .. tostring(spec.kind))
    end
  end
end

---------------------------------------------------------------------------
-- Utilities
---------------------------------------------------------------------------

-- Confirmation alerts that would block an agent with a modal dialog even
-- when it passes ui=false: "format doesn't support layers", "overwrite
-- files?", per-format option prompts. Muted while a request runs, then the
-- user's settings are restored.
local QUIET_ALERTS = {
  { "save_file", "show_file_format_doesnt_support_alert" },
  { "save_file", "show_export_animation_in_sequence_alert" },
  { "export_file", "show_overwrite_files_alert" },
  { "sprite_sheet", "show_overwrite_files_alert" },
  { "gif", "show_alert" }, { "jpeg", "show_alert" }, { "svg", "show_alert" },
  { "tga", "show_alert" }, { "css", "show_alert" }, { "webp", "show_alert" },
}

local function withQuietAlerts(fn, ...)
  local saved = {}
  for i, key in ipairs(QUIET_ALERTS) do
    local ok, section = pcall(function() return app.preferences[key[1]] end)
    if ok and section then
      saved[i] = section[key[2]]
      pcall(function() section[key[2]] = false end)
    end
  end
  local results = table.pack(pcall(fn, ...))
  for i, key in ipairs(QUIET_ALERTS) do
    -- Restore only what is still muted, so a request that sets one of
    -- these preferences on purpose keeps its value.
    if saved[i] ~= nil then
      pcall(function()
        local section = app.preferences[key[1]]
        if section[key[2]] == false then section[key[2]] = saved[i] end
      end)
    end
  end
  if not results[1] then error(results[2], 0) end
  return table.unpack(results, 2, results.n)
end

-- Request params arrive as json.decode values: userdata, not tables, with
-- numbers as floats. Copy them into plain Lua values so handlers can use
-- type(x) == "table" (scopes, saved commands' args), with whole numbers as
-- integers.
local function plain(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "number" then return math.tointeger(v) or v end
  if t ~= "userdata" or depth > 20 then return v end
  local ok, out = pcall(function()
    local copy = {}
    -- Arrays: ipairs (pairs yields nothing). Objects: # counts keys and v[1] is nil.
    if #v > 0 and v[1] ~= nil then
      for i, x in ipairs(v) do copy[i] = plain(x, depth + 1) end
    else
      for k, x in pairs(v) do copy[k] = plain(x, depth + 1) end
    end
    return copy
  end)
  return ok and out or v
end

---------------------------------------------------------------------------
-- Instance
---------------------------------------------------------------------------

-- opts: chunkDir (the extension folder), protocol (protocol.json), and
-- optionally capture (step_capture.lua instance), writePalette(pal, path),
-- onVariations(info), onCommandsChanged(dir).
function M.new(opts)
  local chunkDir = assert(opts and opts.chunkDir, "chunkDir required")
  local PROTOCOL = assert(opts.protocol, "protocol required")
  checkKinds(PROTOCOL)
  local function loadModule(name) return dofile(app.fs.joinPath(chunkDir, name)) end

  local capture = opts.capture                 -- before/after of edit steps
  local onVariations = opts.onVariations       -- who shows variations (the chat panel)
  local onCommandsChanged = opts.onCommandsChanged
  local px = loadModule("pixels.lua")
  local variations = loadModule("variations.lua")    -- AI layers and variations (#25)
  local timelineText = loadModule("timeline_text.lua")
  local scopeGuard = loadModule("scope_guard.lua")
  local wireParams = loadModule("wire_params.lua")
  local view = loadModule("document_view.lua").new{ px = px }
  local layerById = view.layerById
  local agentCursor   -- the last scope shown in the timeline (tests read it)

  -- Convert any Lua value into something json.encode accepts.
  local function toPlain(v, depth)
    depth = depth or 0
    local t = type(v)
    if t == "nil" or t == "boolean" or t == "string" then return v end
    if t == "number" then
      if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
      return v
    end
    if depth > 6 then return tostring(v) end
    if t == "table" then
      local out = {}
      for k, val in pairs(v) do
        out[type(k) == "number" and k or tostring(k)] = toPlain(val, depth + 1)
      end
      return out
    end
    if t == "userdata" then
      local name = view.typeName(v)
      if name == "Color" then return px.colorHex(v) end
      if name == "Point" then return { x = v.x, y = v.y } end
      if name == "Size" then return { width = v.width, height = v.height } end
      if name == "Rectangle" then return { x = v.x, y = v.y, width = v.width, height = v.height } end
      if name == "Layer" then return { layer = v.name } end
      if name == "Frame" then return { frame = v.frameNumber } end
      if name == "Tag" then return { tag = v.name } end
      if name == "Sprite" then return { sprite = v.filename } end
      return tostring(v)
    end
    return tostring(v)
  end

  -- Frames from a frame spec, default all (the same grammar the wire uses).
  local function framesFromParam(sprite, frames)
    return wireParams.resolveFrames(frames, #sprite.frames, app.frame and app.frame.frameNumber or 1, "all")
  end

  -- Visible image layers (through groups), skipping reference layers.
  local function imageLayers(layers, out)
    out = out or {}
    for _, l in ipairs(layers) do
      if l.isGroup then imageLayers(l.layers, out)
      elseif l.isImage and l.isVisible and not l.isReference then out[#out + 1] = l end
    end
    return out
  end

  -------------------------------------------------------------------------
  -- Snapshot
  -------------------------------------------------------------------------

  -- Returns header table and raw RGBA bytes.
  local function snapshot(params)
    local sprite = app.sprite
    if not sprite then error("No active sprite") end

    local frameNumber = params.frame or (app.frame and app.frame.frameNumber) or 1
    if frameNumber < 1 or frameNumber > #sprite.frames then
      error("Frame " .. frameNumber .. " is out of range (1-" .. #sprite.frames .. ")")
    end

    local img = Image(sprite.width, sprite.height, ColorMode.RGB)

    if params.layer then
      local layer = layerById(params.layer, sprite)
      if not layer then error("Layer not found: " .. tostring(params.layer)) end
      if layer.isGroup then error("Snapshot of a group layer is not supported; snapshot the sprite instead") end
      local cel = layer:cel(frameNumber)
      if cel then
        local rgb = px.toRgbImage(cel.image, sprite.palettes[1])
        img:drawImage(rgb, cel.position)
      end
    else
      img:drawSprite(sprite, frameNumber)
    end

    return {
      width = img.width,
      height = img.height,
      frame = frameNumber,
      layer = params.layer,
    }, img.bytes
  end

  -------------------------------------------------------------------------
  -- execute_lua
  -------------------------------------------------------------------------

  local function executeLua(params)
    local code = params.code
    if type(code) ~= "string" then error("params.code must be a string") end

    local output = {}
    local function capturePrint(...)
      local parts = {}
      for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring((select(i, ...)))
      end
      output[#output + 1] = table.concat(parts, "\t")
    end

    local env = setmetatable({
      print = capturePrint, layerById = layerById,
      args = type(params.args) == "table" and params.args or {},   -- saved commands' arguments (#26)
      -- AI layers and variations (#25), see variations.lua.
      aiLayer = variations and variations.aiLayer, variationLayer = variations and variations.variationLayer,
    }, { __index = _G })

    -- A distinct chunk name gives agent code its own entry in Aseprite's
    -- script-access permissions, separate from this extension's trust.
    local chunkName = "@" .. app.fs.joinPath(chunkDir, "agent_exec.lua")
    local fn, compileErr = load(code, chunkName, "t", env)
    if not fn then
      return { ok = false, error = "Compile error: " .. tostring(compileErr), output = output }
    end

    local results
    local function run()
      -- Capture the traceback here, then rethrow so a transaction rolls back.
      local packed = table.pack(xpcall(fn, debug.traceback))
      if not packed[1] then error(packed[2], 0) end
      results = table.pack(table.unpack(packed, 2, packed.n))
    end

    -- app.transaction needs an active document; without one (e.g. code that
    -- creates the first sprite) run the code directly.
    local useTransaction = params.transaction ~= false and app.sprite ~= nil

    local ok, err
    if useTransaction then
      local label = params.label or "AI Agent"
      -- An error inside app.transaction rolls the whole step back.
      ok, err = pcall(app.transaction, label, run)
    else
      ok, err = pcall(run)
    end
    app.refresh()

    if not ok then
      return { ok = false, error = tostring(err), output = output, rolledBack = useTransaction }
    end

    local value
    if results and results.n > 0 then
      if results.n == 1 then
        value = toPlain(results[1])
      else
        value = {}
        for i = 1, results.n do value[i] = toPlain(results[i]) end
      end
    end
    return { ok = true, value = value, output = output }
  end

  -------------------------------------------------------------------------
  -- Core handlers
  -------------------------------------------------------------------------

  local handlers = {}

  handlers.ping = function()
    return { pong = true, asepriteVersion = tostring(app.version), protocol = PROTOCOL.version }
  end

  -- Timeline as text (#32), see timeline_text.lua.
  handlers.get_timeline_text = function()
    return { text = timelineText.serialize(app.sprite) }
  end

  handlers.apply_timeline_text = function(params)
    local s = app.sprite
    local spec, errors = timelineText.parse(params.text or "")
    if #errors > 0 then return { ok = false, errors = errors, changes = {} } end
    local changes
    if params.plan then
      changes, errors = timelineText.plan(s, spec, layerById)
    else
      changes, errors = timelineText.apply(s, spec, layerById)
    end
    return { ok = #errors == 0, errors = errors, changes = changes, applied = (not params.plan and #errors == 0 and #changes > 0) }
  end

  -- Saved commands (#26): syntax check before saving, and a refresh after.
  handlers.compile_lua = function(params)
    local fn, err = load(params.code or "", "=command", "t")
    return { ok = fn ~= nil, error = err }
  end

  handlers.commands_changed = function(params)
    if onCommandsChanged then onCommandsChanged(params.dir) end
    return { ok = true }
  end

  -- Shows the variations of a task to the user (the chat panel's thumbnails).
  handlers.propose_variations = function(params)
    local task = params.task
    if type(task) ~= "string" or task == "" then error("params.task is required") end
    local list = variations.candidates(task)
    if not list or #list == 0 then
      error("No variations for '" .. task .. "'. Build them with variationLayer('" .. task .. "', i) first.")
    end
    local items, names = {}, {}
    local area
    for i, l in ipairs(list) do
      local img = variations.render(l, px.toRgbImage)
      items[i] = { name = l.name, image = img }
      names[i] = l.name
      local b = img:shrinkBounds()
      if not b.isEmpty then area = area and area:union(b) or b end
    end
    -- Thumbnails show the area the candidates cover (plus a margin), so small
    -- drawings stay readable.
    if area then
      local s = app.sprite
      area = Rectangle(area.x - 2, area.y - 2, area.width + 4, area.height + 4):intersect(Rectangle(0, 0, s.width, s.height))
      for _, it in ipairs(items) do it.image = Image(it.image, area) end
    end
    if onVariations then onVariations{ task = task, items = items } end
    return { task = task, count = #list, layers = names, shown = onVariations ~= nil }
  end

  handlers.diff_visual = function(params)
    if not capture then error("Step capture is not enabled") end
    return capture:diffVisual(params)
  end

  handlers.snapshot = function(params)
    return snapshot(params)   -- header, raw RGBA bytes
  end

  handlers.get_state = function()
    return view.getState()
  end

  handlers.get_context = function()
    return view.getContext()
  end

  -- The <aseprite-state> block (for sub-agents' first message, #33).
  handlers.state_block = function()
    return { text = view.stateBlock() }
  end

  handlers.execute_lua = function(params)
    return executeLua(params)
  end

  -- JSON values from the bridge -> Aseprite types for command params.
  local function toLuaParam(v)
    if type(v) ~= "table" and type(v) ~= "userdata" then return v end
    if v.__color then return px.color(v.__color) end
    if v.x ~= nil and v.width ~= nil then return Rectangle(v.x, v.y, v.width, v.height) end
    if v.width ~= nil and v.height ~= nil then return Size(v.width, v.height) end
    if v.x ~= nil and v.y ~= nil then return Point(v.x, v.y) end
    return v
  end

  handlers.run_command = function(params)
    local name = params.name
    if type(name) ~= "string" then error("params.name must be a string") end
    local ok, cmd = pcall(function() return app.command[name] end)
    if not ok then error("Unknown command: " .. name) end

    local args = {}
    for k, v in pairs(params.params or {}) do args[k] = toLuaParam(v) end
    -- Never block the agent on a modal dialog unless it asks for one.
    if args.ui == nil then args.ui = false end

    local executed = cmd(args)
    app.refresh()
    return {
      executed = executed,
      note = (not executed) and "Command did not run (not enabled in the current context, or cancelled)" or nil,
    }
  end

  local MAX_READ_PIXELS = 128 * 128
  local KEY_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

  handlers.read_pixels = function(params)
    local sprite = app.sprite

    local x0 = params.x or 0
    local y0 = params.y or 0
    local w = params.width or (sprite.width - x0)
    local h = params.height or (sprite.height - y0)
    if w <= 0 or h <= 0 then error("Empty region") end
    if w * h > MAX_READ_PIXELS then
      error(string.format("Region %dx%d is too large; read at most %d pixels per call", w, h, MAX_READ_PIXELS))
    end

    local frameNumber = params.frame or (app.frame and app.frame.frameNumber) or 1
    local header, bytes = snapshot{ frame = frameNumber, layer = params.layer }
    local sw = header.width

    local palette = sprite.palettes[1]
    local indexed = sprite.colorMode == ColorMode.INDEXED
    local paletteIndex = {}
    if indexed then
      for i = #palette - 1, 0, -1 do paletteIndex[px.colorHex(palette:getColor(i))] = i end
    end

    -- Indexed sprites use palette indices as keys; RGB sprites get short keys.
    local keys, legend, nextKey = {}, {}, 1
    local rows = {}
    for y = y0, y0 + h - 1 do
      local row = {}
      for x = x0, x0 + w - 1 do
        local token
        if x < 0 or y < 0 or x >= sprite.width or y >= sprite.height then
          token = "-"
        else
          local i = (y * sw + x) * 4
          local r, g, b, a = bytes:byte(i + 1, i + 4)
          if a == 0 then
            token = "."
          else
            local hex = a == 255 and string.format("#%02x%02x%02x", r, g, b)
              or string.format("#%02x%02x%02x%02x", r, g, b, a)
            if indexed and paletteIndex[hex] then
              token = tostring(paletteIndex[hex])
              legend[token] = hex
            else
              token = keys[hex]
              if not token then
                if nextKey <= #KEY_CHARS then
                  token = KEY_CHARS:sub(nextKey, nextKey)
                  if indexed then token = "c" .. token end
                else
                  token = hex
                end
                nextKey = nextKey + 1
                keys[hex] = token
                legend[token] = hex
              end
            end
          end
        end
        row[#row + 1] = token
      end
      rows[#rows + 1] = table.concat(row, " ")
    end

    return {
      x = x0, y = y0, width = w, height = h,
      frame = frameNumber, layer = params.layer,
      keys = indexed and "palette-index" or "color-key",
      legend = legend,
      rows = rows,
    }
  end

  handlers.undo = function(params)
    local n = params.steps or 1
    for _ = 1, n do app.undo() end
    app.refresh()
    return { undone = n }
  end

  handlers.redo = function(params)
    local n = params.steps or 1
    for _ = 1, n do app.redo() end
    app.refresh()
    return { redone = n }
  end

  -------------------------------------------------------------------------
  -- Areas: handler groups in their own files, registered into `handlers`
  -------------------------------------------------------------------------

  local D = {
    px = px, view = view, layerById = layerById, variations = variations, wireParams = wireParams,
    framesFromParam = framesFromParam, imageLayers = imageLayers,
    writePalette = opts.writePalette or function() error("Saving palettes needs agent.lua (opts.writePalette)") end,
  }
  loadModule("handlers_check.lua")(handlers, D)
  loadModule("handlers_color.lua")(handlers, D)
  loadModule("handlers_sprite.lua")(handlers, D)

  -------------------------------------------------------------------------
  -- Policy: how H.call runs a request
  -------------------------------------------------------------------------

  -- A sub-agent's request (#33). Reads run as they are. A "write" the scope
  -- guard can't check is refused (undo and redo could undo another agent's
  -- work). A "scoped-write" runs, is undone if it changed anything outside
  -- the scope, and highlights the scope in the timeline (the agent cursor).
  local function callScoped(method, spec, params, run)
    if spec.kind == "read" then return run() end
    if spec.kind == "write" then
      if method == "undo" or method == "redo" then
        error("Sub-agents can't use " .. method .. ": it could undo another agent's work. Fix forward with execute_lua.")
      end
      error("Sub-agents can't use " .. method .. ": the scope guard can't check what it changes " ..
        "(the palette, slices or another sprite). Leave it to the lead agent, or edit your frames with execute_lua.")
    end
    local sprite = app.sprite
    local scope, err = scopeGuard.resolve(sprite, params.scope, layerById)
    if not scope then error(err) end
    local before = scopeGuard.snapshot(sprite, scope)
    local history = sprite.undoHistory
    local undoBefore = history and history.current or 0
    local results = table.pack(run())
    local problem = scopeGuard.check(sprite, scope, before)
    if problem then
      if app.sprite == sprite then sprite:undoTo(undoBefore) end
      app.refresh()
      error("Out of scope: " .. problem .. ". You may only edit " .. scopeGuard.describe(scope) ..
        ". The step was undone.")
    end
    -- Agent cursor: show the frames this agent works on in the timeline.
    local ok, cursorErr = pcall(function()
      local frames, numbers = {}, {}
      for f in pairs(scope.frames) do frames[#frames + 1] = sprite.frames[f]; numbers[#numbers + 1] = f end
      table.sort(numbers)
      app.range.frames = frames
      app.refresh()
      agentCursor = { frames = numbers, label = scope.label, set = #app.range.frames, clock = os.clock() }
    end)
    if not ok then agentCursor = { error = tostring(cursorErr) } end
    return table.unpack(results, 1, results.n)
  end

  local H = {
    handlers = handlers,
    view = view,
    getState = view.getState,
    executeLua = executeLua,
    snapshot = snapshot,
    contextString = view.contextString,
    stateBlock = view.stateBlock,
    layerById = layerById,
    check = handlers.check,
    Uri = view.Uri,
    variations = function() return variations end,
    agentCursor = function() return agentCursor end,
  }

  -- Answers one protocol request. Errors propagate to the caller.
  -- Wrappers, outermost first: scope guard, step capture, quiet alerts,
  -- the handler (whose own app.transaction makes one undo step).
  function H.call(method, params)
    local handler = handlers[method]
    local spec = PROTOCOL.requests[method]
    if not handler or not spec then
      error({ code = -32601, message = "Unknown method: " .. tostring(method) })
    end
    params = plain(params) or {}
    -- Schema check, layer ids and frame numbers resolved once (#53).
    params = wireParams.check(method, spec.params or {}, params, {
      sprite = app.sprite, activeFrame = app.frame and app.frame.frameNumber, layerById = layerById,
    })
    local scoped = type(params.scope) == "table"
    if scoped and spec.kind == "write" then return callScoped(method, spec, params) end
    if M.needsSprite(spec) and not app.sprite then error("No active sprite") end
    local function run()
      if capture then return capture:around(method, withQuietAlerts, handler, params) end
      return withQuietAlerts(handler, params)
    end
    if scoped then return callScoped(method, spec, params, run) end
    return run()
  end

  return H
end

return M
