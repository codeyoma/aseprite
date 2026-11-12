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
-- Document-scoped requests (#90): a request names the sprite it acts on
-- (route.doc, "S<sprite id>": the envelope's doc, else the chat's sprite).
-- H.call resolves it once into the request's site (D.site(): sprite, frame,
-- layer, active) and handlers act on that, never on app.sprite, so a chat's
-- requests run on its sprite while the user works in another tab. Without a
-- doc they act on the active sprite. Changes go through D.transaction(sprite,
-- ...): sprite:transaction (this fork, src/app/script/sprite_class.cpp) when
-- the build has it, otherwise the sprite is made active for that one
-- transaction. Requests marked "activates" in protocol.json (execute_lua,
-- run_command, apply_timeline_text) and the parts of handlers that need
-- Aseprite's active document (commands, app.range) run inside D.withActive,
-- which makes the sprite active and gives the user's sprite, frame and layer
-- back afterwards.
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
    -- Arrays: ipairs (pairs yields nothing). Objects: pairs yields their keys.
    -- # and v[1] can't tell them apart: an object with the key "1" (a
    -- write_pixels legend) answers v[1] too.
    local isObject = false
    for _ in pairs(v) do isObject = true; break end
    if not isObject and #v > 0 then
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
  local motionGate = loadModule("motion_gate.lua")
  local wireParams = loadModule("wire_params.lua")
  local view = loadModule("document_view.lua").new{ px = px }
  local layerById = view.layerById
  local agentCursor   -- the last scope shown in the timeline (tests read it)

  -------------------------------------------------------------------------
  -- The request's sprite (#90): site, activation, transactions
  -------------------------------------------------------------------------

  local site                 -- the request being answered: { sprite, frame, layer, active }
  local lastSite = {}        -- sprite id -> { frame, layerId }: where it was when last active
  local stats = { activations = 0 }   -- tests: how often a request made its sprite active
  local spriteTx = nil       -- nil: use sprite:transaction when the build has it; false: never (tests)

  local function spriteById(id)
    for _, s in ipairs(app.sprites) do if s.id == id then return s end end
  end

  -- A doc ("S12" or 12) to its open sprite; nil gives the active sprite. A
  -- doc that names no open sprite is an error, never the active sprite.
  local function resolveSprite(doc)
    if doc == nil then return app.sprite end
    local n = math.tointeger(tonumber((tostring(doc):gsub("^S", ""))))
    local s = n and spriteById(n)
    if not s then error("Sprite not found: " .. tostring(doc) .. " (it was closed, or is not open in this Aseprite)", 0) end
    return s
  end

  -- Records where the active sprite is (frame, layer): the default site of
  -- its later requests while another tab is active.
  local function noteSite()
    local s = app.sprite
    if not s then return end
    lastSite[s.id] = { frame = app.frame and app.frame.frameNumber or 1, layerId = app.layer and app.layer.id or nil }
  end

  -- The topmost image layer: the default layer of a sprite never seen active.
  local function topImageLayer(layers)
    for i = #layers, 1, -1 do
      local l = layers[i]
      if l.isGroup then
        local f = topImageLayer(l.layers)
        if f then return f end
      elseif l.isImage then return l end
    end
  end

  -- The site of a request on `sprite`: the active sprite's frame and layer,
  -- or for another sprite where it was when last active (frame 1 and its top
  -- image layer when never seen).
  local function siteOf(sprite)
    if not sprite then return { active = true } end
    if sprite == app.sprite then
      return { sprite = sprite, frame = app.frame and app.frame.frameNumber or 1, layer = app.layer, active = true }
    end
    local rec = lastSite[sprite.id] or {}
    local frame = rec.frame
    if not frame or frame > #sprite.frames then frame = 1 end
    local layer = rec.layerId and layerById("L" .. rec.layerId, sprite) or nil
    if layer and layer.id ~= rec.layerId then layer = nil end
    return { sprite = sprite, frame = frame, layer = layer or topImageLayer(sprite.layers), active = false }
  end

  -- The site of the request being answered; outside one (tests calling a
  -- handler directly, saved commands) the active sprite's.
  local function here() return site or siteOf(app.sprite) end

  -- Moves the site's frame and layer: the user's when the sprite is active,
  -- otherwise the remembered ones for its next requests.
  local function selectSite(s, frame, layer)
    if not s or not s.sprite then return end
    if frame then s.frame = frame end
    if layer then s.layer = layer end
    if app.sprite == s.sprite then
      if frame then pcall(function() app.frame = s.sprite.frames[frame] end) end
      if layer then pcall(function() app.layer = layer end) end
      return
    end
    local rec = lastSite[s.sprite.id] or {}
    lastSite[s.sprite.id] = rec
    if frame then rec.frame = frame end
    if layer then rec.layerId = layer.id end
  end

  -- Runs fn with `sprite` active, for what only works on Aseprite's active
  -- document (commands, app.range, agent-written Lua). The user's sprite,
  -- frame and layer come back afterwards, also after an error. A sprite fn
  -- makes or opens is noted in site.moved (the chat moves there).
  local function withActive(sprite, fn)
    if not sprite or app.sprite == sprite then return fn() end
    stats.activations = stats.activations + 1
    noteSite()
    local prev, prevFrame, prevLayer = app.sprite, app.frame, app.layer
    app.sprite = sprite
    if site and site.sprite == sprite then
      pcall(function() app.frame = sprite.frames[site.frame] end)
      if site.layer then pcall(function() app.layer = site.layer end) end
    end
    local results = table.pack(pcall(fn))
    if app.sprite == sprite then noteSite()
    elseif app.sprite and site then site.moved = app.sprite end
    if prev and pcall(function() return prev.width end) then
      app.sprite = prev
      pcall(function() app.frame = prevFrame end)
      pcall(function() app.layer = prevLayer end)
    end
    if not results[1] then error(results[2], 0) end
    return table.unpack(results, 2, results.n)
  end

  -- One undo step on `sprite`, whichever tab is active: sprite:transaction
  -- (this fork) when the build has it, otherwise app.transaction with the
  -- sprite made active for it.
  local function transaction(sprite, label, fn)
    if spriteTx ~= false then
      local ok, method = pcall(function() return sprite.transaction end)
      if ok and method then return sprite:transaction(label, fn) end
    end
    return withActive(sprite, function() return app.transaction(label, fn) end)
  end

  -- Moves a sprite's undo history n steps back (n < 0) or forward, as app.undo
  -- and app.redo do on the active sprite: undo goes to the previous state in
  -- the history's list, redo to the next. Returns how many steps it moved.
  local function stepHistory(sprite, n)
    local h = sprite.undoHistory
    if not h or not h.states then error("This Aseprite build can't undo a sprite by id (needs sprite:undoTo)", 0) end
    local states, at = h.states, 0
    for i, st in ipairs(states) do if st.id == h.current then at = i end end
    local to = math.max(0, math.min(#states, at + n))
    if to == at then return 0 end
    sprite:undoTo(to == 0 and 0 or states[to].id)
    return math.abs(to - at)
  end

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
    return wireParams.resolveFrames(frames, #sprite.frames, here().frame or 1, "all")
  end

  -- Visible image layers (through visible groups, as the snapshot renders
  -- them), skipping reference layers.
  local function imageLayers(layers, out)
    out = out or {}
    for _, l in ipairs(layers) do
      if l.isGroup then
        if l.isVisible then imageLayers(l.layers, out) end
      elseif l.isImage and l.isVisible and not l.isReference then out[#out + 1] = l end
    end
    return out
  end

  -------------------------------------------------------------------------
  -- Snapshot
  -------------------------------------------------------------------------

  -- Returns header table and raw RGBA bytes.
  local function snapshot(params)
    local sprite = here().sprite
    if not sprite then error("No active sprite") end

    local frameNumber = params.frame or (here().sprite == sprite and here().frame)
      or (app.frame and app.frame.frameNumber) or 1
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
        local rgb = px.toRgbImage(cel.image, sprite.palettes[1], layer.isTilemap and layer.tileset or nil)
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
    return { text = timelineText.serialize(here().sprite) }
  end

  -- Runs with its sprite active (protocol.json "activates"): linking cels is a command over app.range.
  handlers.apply_timeline_text = function(params)
    local s = here().sprite
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
    local list = variations.candidates(task, here().sprite)
    if not list or #list == 0 then
      error("No variations for '" .. task .. "'. Build them with variationLayer('" .. task .. "', i) first.")
    end
    local items, names = {}, {}
    local area
    for i, l in ipairs(list) do
      local img = variations.render(l, px.toRgbImage, here().frame)
      items[i] = { name = l.name, image = img }
      names[i] = l.name
      local b = img:shrinkBounds()
      if not b.isEmpty then area = area and area:union(b) or b end
    end
    -- Thumbnails show the area the candidates cover (plus a margin), so small
    -- drawings stay readable.
    if area then
      local s = here().sprite
      area = Rectangle(area.x - 2, area.y - 2, area.width + 4, area.height + 4):intersect(Rectangle(0, 0, s.width, s.height))
      for _, it in ipairs(items) do it.image = Image(it.image, area) end
    end
    if onVariations then onVariations{ task = task, items = items } end
    return { task = task, count = #list, layers = names, shown = onVariations ~= nil }
  end

  handlers.diff_visual = function(params)
    if not capture then error("Step capture is not enabled") end
    return capture:diffVisual(params, here())
  end

  handlers.snapshot = function(params)
    -- Several frames in one reply (#114): their RGBA one after another in one binary frame.
    if params.frames ~= nil then
      if type(params.frames) ~= "table" or #params.frames == 0 or #params.frames > 64 then
        error("frames must list 1 to 64 frame numbers")
      end
      local parts, header, list = {}, nil, {}
      for i, f in ipairs(params.frames) do
        if math.type(f) ~= "integer" then error("frames[" .. i .. "] must be a whole frame number") end
        local h, bytes = snapshot{ layer = params.layer, frame = f }
        header = header or h
        parts[#parts + 1] = bytes
        list[#list + 1] = f
      end
      return { width = header.width, height = header.height, frames = list, layer = params.layer }, table.concat(parts)
    end
    return snapshot(params)   -- header, raw RGBA bytes
  end

  handlers.get_state = function()
    return view.getState(here())
  end

  -- The <aseprite-state> block (for sub-agents' first message, #33).
  handlers.state_block = function()
    return { text = view.stateBlock(here()) }
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

  -- Hex -> palette index for an indexed sprite's keys: the lowest index with
  -- that color, never the transparent index (a pixel there reads as '.'), so
  -- read_pixels and write_pixels give a color the same key (#74).
  local function paletteKeys(sprite)
    local palette, mask = sprite.palettes[1], sprite.transparentColor
    local out = {}
    for i = #palette - 1, 0, -1 do
      if i ~= mask then out[px.colorHex(palette:getColor(i))] = i end
    end
    return out
  end

  handlers.read_pixels = function(params)
    local sprite = here().sprite

    local x0 = params.x or 0
    local y0 = params.y or 0
    local w = params.width or (sprite.width - x0)
    local h = params.height or (sprite.height - y0)
    if w <= 0 or h <= 0 then error("Empty region") end
    if w * h > MAX_READ_PIXELS then
      error(string.format("Region %dx%d is too large; read at most %d pixels per call", w, h, MAX_READ_PIXELS))
    end

    local frameNumber = params.frame or here().frame
    local header, bytes = snapshot{ frame = frameNumber, layer = params.layer }
    local sw = header.width

    local palette = sprite.palettes[1]
    local indexed = sprite.colorMode == ColorMode.INDEXED
    local paletteIndex = indexed and paletteKeys(sprite) or {}

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

  -- Writable pixel grid (#74): write_pixels takes rows and a legend in the
  -- format read_pixels returns and writes them into one layer's cel at x, y.
  -- A key means what read_pixels made it mean: in an indexed sprite a number
  -- is that palette entry, any other key is looked up in the legend; '#hex'
  -- is that color; '.' is transparent; '-' leaves the pixel as it is
  -- (read_pixels writes it outside the canvas). Ragged rows and unknown keys
  -- are refused with their row and column, never padded. One undo step; the
  -- cel keeps its position and grows to cover painted pixels outside it.
  -- The idea and its strict, located errors come from aseprite-ai-artist's
  -- PixelGrid (src/lib/grid.ts; MIT License, Copyright (c) 2026
  -- with-pebbly, https://github.com/with-pebbly/aseprite-ai-artist).
  local GRID_KEEP, GRID_CLEAR = {}, {}

  -- Pixel values from keys for one sprite: resolve(key) -> GRID_KEEP,
  -- GRID_CLEAR or a pixel value; nil and a reason when unknown. Shared by
  -- write_pixels and apply (handlers_apply.lua).
  local function gridKeys(sprite, legendParam)
    -- The legend: key -> normalized hex.
    local legend = {}
    for k, v in pairs(legendParam or {}) do
      k = tostring(k)
      if k == "." or k == "-" then
        error("Legend key '" .. k .. "' is reserved: '.' is transparent and '-' leaves a pixel unchanged", 0)
      end
      local ok, r, g, b, a = pcall(px.parseHex, v)
      if not ok then error(string.format("Legend key '%s': %s is not a color (use #rrggbb or #rrggbbaa)", k, tostring(v)), 0) end
      legend[k] = px.hex(r, g, b, a)
    end

    local cm = sprite.colorMode
    local indexed = cm == ColorMode.INDEXED
    local palette = sprite.palettes[1]
    local paletteIndex = indexed and paletteKeys(sprite) or nil
    local pc = app.pixelColor
    local clearValue = indexed and sprite.transparentColor or 0

    local function pixelOfHex(hex)
      local r, g, b, a = px.parseHex(hex)
      if a == 0 then return GRID_CLEAR end
      if cm == ColorMode.RGB then return pc.rgba(r, g, b, a) end
      if indexed then
        local i = paletteIndex[px.hex(r, g, b, a)]
        if not i then return nil, hex .. " is not in the palette (indexed sprite)" end
        return i
      end
      if r ~= g or g ~= b then return nil, hex .. " is not a gray (grayscale sprite)" end
      return pc.graya(r, a)
    end
    local cache = {}
    local function resolve(t)
      if t == "-" then return GRID_KEEP end
      if t == "." then return GRID_CLEAR end
      if cache[t] then return cache[t] end
      local v, why
      local hex = legend[t]
      if indexed and t:match("^%d+$") then
        local i = tonumber(t)
        if i >= #palette then
          why = string.format("palette index %d is past the palette's end (%d colors)", i, #palette)
        elseif hex and hex ~= px.colorHex(palette:getColor(i)) then
          why = string.format("the legend says '%s' is %s but palette entry %d is %s", t, hex, i, px.colorHex(palette:getColor(i)))
        else
          v = (i == clearValue) and GRID_CLEAR or i
        end
      else
        if not hex and t:sub(1, 1) == "#" and pcall(px.parseHex, t) then hex = t end
        if not hex then
          why = "unknown key '" .. t .. "'; add it to the legend or use '.' for transparent"
        else
          v, why = pixelOfHex(hex)
        end
      end
      cache[t] = v
      return v, why
    end
    return resolve, clearValue
  end

  -- Rows of keys at x0, y0 to a list of writes { x, y, value } (every pixel
  -- checked before anything changes) and how many pixels they cover.
  local function gridWrites(sprite, rows, legend, x0, y0)
    if type(rows) ~= "table" or #rows == 0 then error("rows must list at least one row", 0) end
    -- Rows of keys, all the same width.
    local grid, width = {}, 0
    for r, row in ipairs(rows) do
      if type(row) ~= "string" then error(string.format("Row %d is not text", r), 0) end
      local cells = {}
      for t in row:gmatch("%S+") do cells[#cells + 1] = t end
      if r == 1 then
        width = #cells
        if width == 0 then error("Row 1 is empty", 0) end
      elseif #cells ~= width then
        error(string.format("Row %d (y=%d) has %d pixels but row 1 has %d. Every row must be the same width; rows are never padded",
          r, y0 + r - 1, #cells, width), 0)
      end
      grid[r] = cells
    end
    if width * #grid > MAX_READ_PIXELS then
      error(string.format("Grid %dx%d is too large; write at most %d pixels per call", width, #grid, MAX_READ_PIXELS), 0)
    end
    local resolve = gridKeys(sprite, legend)
    local writes = {}
    for r, cells in ipairs(grid) do
      for c, t in ipairs(cells) do
        local x, y = x0 + c - 1, y0 + r - 1
        local v, why = resolve(t)
        if v == nil then error(string.format("Row %d, column %d (x=%d, y=%d): %s", r, c, x, y, why), 0) end
        if v ~= GRID_KEEP then
          if x < 0 or y < 0 or x >= sprite.width or y >= sprite.height then
            error(string.format("Row %d, column %d (x=%d, y=%d) is outside the %dx%d canvas; write '-' there",
              r, c, x, y, sprite.width, sprite.height), 0)
          end
          writes[#writes + 1] = { x, y, v }
        end
      end
    end
    return writes
  end

  -- Writes { x, y, value } (value: a pixel or GRID_CLEAR) into one layer's
  -- cel. The cel keeps its position and grows to cover painted pixels.
  -- Returns the result and a function that makes the change (nil when
  -- nothing changes); the caller runs it inside its transaction.
  local function celWrites(sprite, layer, frame, writes)
    local cm = sprite.colorMode
    local clearValue = cm == ColorMode.INDEXED and sprite.transparentColor or 0
    local bx0, by0, bx1, by1
    for _, w in ipairs(writes) do
      if w[3] ~= GRID_CLEAR then
        local x, y = w[1], w[2]
        bx0 = bx0 and math.min(bx0, x) or x; by0 = by0 and math.min(by0, y) or y
        bx1 = bx1 and math.max(bx1, x) or x; by1 = by1 and math.max(by1, y) or y
      end
    end

    -- The cel's bounds, grown to cover painted pixels.
    local cel = layer:cel(frame)
    local ox, oy, ow, oh
    if cel then ox, oy, ow, oh = cel.position.x, cel.position.y, cel.image.width, cel.image.height end
    local nx, ny, nx1, ny1 = ox, oy, ox and ox + ow - 1, oy and oy + oh - 1
    if bx0 then
      nx = nx and math.min(nx, bx0) or bx0; ny = ny and math.min(ny, by0) or by0
      nx1 = nx1 and math.max(nx1, bx1) or bx1; ny1 = ny1 and math.max(ny1, by1) or by1
    end
    local result = { written = #writes, changed = 0, layer = "L" .. layer.id, frame = frame }
    if not nx then return result end   -- only clears where there is no cel
    local nw, nh = nx1 - nx + 1, ny1 - ny + 1
    local grown = not cel or nx ~= ox or ny ~= oy or nw ~= ow or nh ~= oh

    local img
    if grown then
      img = Image(nw, nh, cm)
      img:clear(clearValue)
      if cel then
        local dx, dy = ox - nx, oy - ny
        for it in cel.image:pixels() do img:drawPixel(it.x + dx, it.y + dy, it()) end
      end
    else
      img = cel.image:clone()
    end
    local changed = 0
    for _, w in ipairs(writes) do
      local ix, iy = w[1] - nx, w[2] - ny
      if ix >= 0 and iy >= 0 and ix < nw and iy < nh then
        local v = w[3] == GRID_CLEAR and clearValue or w[3]
        if img:getPixel(ix, iy) ~= v then
          img:drawPixel(ix, iy, v)
          changed = changed + 1
        end
      end
    end
    result.changed = changed
    result.cel = { x = nx, y = ny, width = nw, height = nh }
    if changed == 0 and not grown then return result end
    return result, function()
      if cel then
        cel.image = img
        if nx ~= ox or ny ~= oy then cel.position = Point(nx, ny) end
      else
        sprite:newCel(layer, frame, img, Point(nx, ny))
      end
    end
  end

  -- The image layer a pixel write goes to: params.layer (id or name) or the site's layer.
  local function pixelLayer(sprite, ref, what)
    local layer = ref and layerById(ref, sprite) or (not ref and here().sprite == sprite and here().layer) or nil
    if not layer then
      if ref then error("Layer not found: " .. tostring(ref), 0) end
      error("No layer to write to", 0)
    end
    if layer.isGroup or layer.isTilemap or not layer.isImage then
      error(what .. " writes into an image layer; " .. layer.name .. " is not one", 0)
    end
    return layer
  end

  handlers.write_pixels = function(params)
    local sprite = here().sprite
    local layer = pixelLayer(sprite, params.layer, "write_pixels")
    local frame = params.frame or here().frame
    local writes = gridWrites(sprite, params.rows, params.legend, params.x or 0, params.y or 0)
    local result, commit = celWrites(sprite, layer, frame, writes)
    if commit then
      transaction(sprite, "Write pixels", commit)
      app.refresh()
    end
    return result
  end

  -- Undo and redo move the request's sprite's own history (sprite:undoTo),
  -- so they never touch another sprite's history or the active tab.
  handlers.undo = function(params)
    local n = params.steps or 1
    stepHistory(here().sprite, -n)
    app.refresh()
    return { undone = n }
  end

  handlers.redo = function(params)
    local n = params.steps or 1
    stepHistory(here().sprite, n)
    app.refresh()
    return { redone = n }
  end

  -------------------------------------------------------------------------
  -- Areas: handler groups in their own files, registered into `handlers`
  -------------------------------------------------------------------------

  -- The binary frame of the request being answered (#95), for D.bytes.
  local blob
  local D = {
    -- A bytes param's bytes (base64 or a slice of the request's binary frame).
    bytes = function(v) return wireParams.bytes(v, blob, px.base64Decode) end,
    px = px, view = view, layerById = layerById, variations = variations, wireParams = wireParams,
    framesFromParam = framesFromParam, imageLayers = imageLayers,
    -- The request's sprite (#90): its site, one undo step on it, running with it active, moving its frame and layer.
    site = here, transaction = transaction, withActive = withActive, select = selectSite,
    -- Pixel writes (write_pixels' grid, for apply): see gridKeys, gridWrites, celWrites.
    GRID_CLEAR = GRID_CLEAR, gridKeys = gridKeys, gridWrites = gridWrites, celWrites = celWrites, pixelLayer = pixelLayer,
    writePalette = opts.writePalette or function() error("Saving palettes needs agent.lua (opts.writePalette)") end,
    -- check's pixel rules: nil uses the fork's native Image helpers when present (#95), false the Lua walk.
    nativeCheck = nil,
  }
  loadModule("handlers_check.lua")(handlers, D)
  loadModule("handlers_color.lua")(handlers, D)
  loadModule("handlers_sprite.lua")(handlers, D)
  loadModule("handlers_apply.lua")(handlers, D)


  -------------------------------------------------------------------------
  -- Policy: how H.call runs a request
  -------------------------------------------------------------------------

  -- A sub-agent's request (#33). Reads run as they are. A "write" the scope
  -- guard can't check is refused (undo and redo could undo another agent's
  -- work). A "scoped-write" runs, is undone if it changed anything outside
  -- the scope, and highlights the scope in the timeline (the agent cursor)
  -- when its sprite is on screen. Guards are per request and per sprite: the
  -- snapshot and the undo are of the request's sprite (#90).
  local function callScoped(method, spec, params, run)
    if spec.kind == "read" then return run() end
    if spec.kind == "write" then
      if method == "undo" or method == "redo" then
        error("Sub-agents can't use " .. method .. ": it could undo another agent's work. Fix forward with execute_lua.")
      end
      error("Sub-agents can't use " .. method .. ": the scope guard can't check what it changes " ..
        "(the palette, slices or another sprite). Leave it to the lead agent, or edit your frames with execute_lua.")
    end
    local s = site
    local sprite = s.sprite
    local scope, err = scopeGuard.resolve(sprite, params.scope, layerById)
    if not scope then error(err) end
    local before = scopeGuard.snapshot(sprite, scope)
    local history = sprite.undoHistory
    local undoBefore = history and history.current or 0
    local results = table.pack(run())
    local problem = s.moved and "it switched to or created another sprite" or scopeGuard.check(sprite, scope, before)
    if problem then
      sprite:undoTo(undoBefore)
      app.refresh()
      error("Out of scope: " .. problem .. ". You may only edit " .. scopeGuard.describe(scope) ..
        ". The step was undone.")
    end
    -- Agent cursor: show the frames this agent works on in the timeline
    -- (app.range belongs to the sprite on screen, so only there).
    if app.sprite == sprite then
      local ok, cursorErr = pcall(function()
        local frames, numbers = {}, {}
        for f in pairs(scope.frames) do frames[#frames + 1] = sprite.frames[f]; numbers[#numbers + 1] = f end
        table.sort(numbers)
        app.range.frames = frames
        app.refresh()
        agentCursor = { frames = numbers, label = scope.label, set = #app.range.frames, clock = os.clock() }
      end)
      if not ok then agentCursor = { error = tostring(cursorErr) } end
    end
    return table.unpack(results, 1, results.n)
  end

  -- Entry points used outside a request (saved commands, the panel's
  -- attachments) act on the active sprite.
  local function outside(fn)
    return function(...)
      local outer = site
      site = nil
      return (function(...) site = outer; return ... end)(fn(...))
    end
  end

  local H = {
    handlers = handlers,
    view = view,
    getState = view.getState,
    executeLua = outside(executeLua),
    snapshot = outside(snapshot),
    contextString = view.contextString,
    stateBlock = view.stateBlock,
    layerById = layerById,
    check = outside(handlers.check),
    -- Tests: false makes check walk pixels in Lua even where the native helpers exist (#95); nil restores.
    setNativeCheck = function(on) D.nativeCheck = on end,
    -- Tests: false never uses sprite:transaction (as on a build without it), so transactions activate the sprite; nil restores.
    setSpriteTransactions = function(on) spriteTx = on end,
    -- Whether this build can make one undo step on a sprite that isn't active (sprite:transaction).
    hasSpriteTransactions = function()
      local s = app.sprite
      if spriteTx == false or s == nil then return false end
      local ok, method = pcall(function() return s.transaction end)
      return ok and method ~= nil
    end,
    -- How often a request made its sprite active (tests: document-scoped requests don't).
    stats = function() return { activations = stats.activations } end,
    -- Records the active sprite's frame and layer (the panel calls it on every tab switch).
    noteSite = noteSite,
    resolveSprite = resolveSprite,
    Uri = view.Uri,
    variations = function() return variations end,
    agentCursor = function() return agentCursor end,
  }

  -- Answers one protocol request. Errors propagate to the caller.
  -- Wrappers, outermost first: scope guard, step capture, quiet alerts,
  -- the handler (whose own transaction makes one undo step).
  -- bytes: the request's binary frame (#95), which { offset, length } params refer to.
  -- route (#90): { doc = "S12" or a sprite id } names the sprite the request
  -- acts on (default: the active sprite); after the call, route.moved is the
  -- id of a sprite the request made or opened (the chat moves there).
  -- No pcall around it, so errors keep their traceback; every call sets blob
  -- and site anew, so ones left after an error are never read by a later request.
  local call
  local function restore(outerBlob, outerSite, route, ...)
    if route and site and site.moved then route.moved = site.moved.id end
    blob, site = outerBlob, outerSite
    return ...
  end
  function H.call(method, params, bytes, route)
    local outerBlob, outerSite = blob, site
    blob = bytes
    return restore(outerBlob, outerSite, route, call(method, params, route))
  end

  call = function(method, params, route)
    local handler = handlers[method]
    local spec = PROTOCOL.requests[method]
    if not handler or not spec then
      error({ code = -32601, message = "Unknown method: " .. tostring(method) })
    end
    params = plain(params) or {}
    local sprite = resolveSprite(route and route.doc)
    noteSite()
    local activeBefore = app.sprite
    site = siteOf(sprite)
    -- Schema check, layer ids and frame numbers resolved once against the request's sprite (#53, #90);
    -- the only check of a request's params (#96).
    params = wireParams.check(method, spec.params or {}, params, {
      sprite = sprite, activeFrame = site.frame, layerById = layerById,
    }, PROTOCOL.shapes)
    local scoped = type(params.scope) == "table"
    if scoped and spec.kind == "write" then return callScoped(method, spec, params) end
    if M.needsSprite(spec) and not sprite then error("No active sprite") end
    local s = site
    -- The handler; "activates" requests run with their sprite active (agent-written Lua, commands).
    -- A sprite the request made or opened is noted, before step capture looks at the result.
    local function handle(p)
      local results
      if spec.activates and s.sprite then
        results = table.pack(withActive(s.sprite, function() return handler(p) end))
      else
        results = table.pack(handler(p))
      end
      if not s.moved and app.sprite ~= activeBefore and app.sprite then s.moved = app.sprite end
      return table.unpack(results, 1, results.n)
    end
    local function runHandler()
      if capture then return capture:aroundSite(s, method, withQuietAlerts, handle, params) end
      return withQuietAlerts(handle, params)
    end
    -- Motion stage gate (#99): in an animation's "keys" stage an edit may change only the key frames of its tag.
    local function run()
      local gate = spec.kind == "scoped-write" and sprite and motionGate.read(sprite) or nil
      if not gate then return runHandler() end
      local before = motionGate.snapshot(sprite, gate)
      local undoBefore = sprite.undoHistory and sprite.undoHistory.current or 0
      local results = table.pack(runHandler())
      local problem = motionGate.check(sprite, gate, before)
      if problem then
        sprite:undoTo(undoBefore)
        app.refresh()
        error(problem .. ". " .. motionGate.describe(sprite, gate) .. " The step was undone.")
      end
      return table.unpack(results, 1, results.n)
    end
    if scoped then return callScoped(method, spec, params, run) end
    return run()
  end

  return H
end

return M
