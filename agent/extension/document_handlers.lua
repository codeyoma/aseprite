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

local chunkDir = "."     -- set by new(): agent code gets its own chunk name here
local PROTOCOL = nil     -- set by new()

---------------------------------------------------------------------------
-- Utilities
---------------------------------------------------------------------------

local function colorToHex(c)
  if c.alpha == 255 then
    return string.format("#%02x%02x%02x", c.red, c.green, c.blue)
  end
  return string.format("#%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
end

local COLOR_MODES = {
  [ColorMode.RGB] = "rgb",
  [ColorMode.GRAYSCALE] = "grayscale",
  [ColorMode.INDEXED] = "indexed",
}
if ColorMode.TILEMAP then COLOR_MODES[ColorMode.TILEMAP] = "tilemap" end

local ANI_DIRS = {
  [AniDir.FORWARD] = "forward",
  [AniDir.REVERSE] = "reverse",
  [AniDir.PING_PONG] = "ping-pong",
}
if AniDir.PING_PONG_REVERSE then ANI_DIRS[AniDir.PING_PONG_REVERSE] = "ping-pong-reverse" end

local function typeName(v)
  local mt = getmetatable(v)
  return mt and mt.__name or type(v)
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
    local name = typeName(v)
    if name == "Color" then return colorToHex(v) end
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

---------------------------------------------------------------------------
-- Document description
---------------------------------------------------------------------------

-- "Group/Sub/Layer" path of a layer, for nested groups.
local function layerPath(layer)
  local parts = { layer.name }
  local p = layer.parent
  while p and typeName(p) == "Layer" do
    table.insert(parts, 1, p.name)
    p = p.parent
  end
  return table.concat(parts, "/")
end

local function describeLayers(layers)
  local out = {}
  -- Top-most layer first, as in the timeline.
  for i = #layers, 1, -1 do
    local l = layers[i]
    local item = {
      name = l.name,
      stackIndex = l.stackIndex,
      visible = l.isVisible,
      editable = l.isEditable,
      group = l.isGroup,
    }
    if l.isGroup then
      item.layers = describeLayers(l.layers)
    else
      item.opacity = l.opacity
      item.tilemap = l.isTilemap or nil
      item.background = l.isBackground or nil
      item.reference = l.isReference or nil
      local cels = {}
      for _, cel in ipairs(l.cels) do
        cels[#cels + 1] = cel.frameNumber
      end
      item.celFrames = cels
    end
    out[#out + 1] = item
  end
  return out
end

local function describeSprite(sprite, full)
  local info = {
    filename = sprite.filename,
    width = sprite.width,
    height = sprite.height,
    colorMode = COLOR_MODES[sprite.colorMode] or tostring(sprite.colorMode),
    frameCount = #sprite.frames,
    layerCount = #sprite.layers,
    modified = sprite.isModified,
  }
  if not full then return info end

  info.layers = describeLayers(sprite.layers)

  local frames = {}
  for i, f in ipairs(sprite.frames) do
    frames[i] = { frame = i, durationMs = math.floor(f.duration * 1000 + 0.5) }
  end
  info.frames = frames

  local tags = {}
  for _, t in ipairs(sprite.tags) do
    tags[#tags + 1] = {
      name = t.name,
      from = t.fromFrame.frameNumber,
      to = t.toFrame.frameNumber,
      direction = ANI_DIRS[t.aniDir] or tostring(t.aniDir),
      ["repeat"] = t.repeats,
    }
  end
  info.tags = tags

  local pal = sprite.palettes[1]
  local colors = {}
  local limit = math.min(#pal, 256)
  for i = 0, limit - 1 do
    colors[#colors + 1] = colorToHex(pal:getColor(i))
  end
  info.palette = { size = #pal, colors = colors }

  local sel = sprite.selection
  if sel and not sel.isEmpty then
    local b = sel.bounds
    info.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  return info
end

local function getState()
  local sprites = {}
  for _, s in ipairs(app.sprites) do
    sprites[#sprites + 1] = describeSprite(s, false)
  end

  local state = {
    asepriteVersion = tostring(app.version),
    apiVersion = app.apiVersion,
    openSprites = sprites,
    tool = app.tool and app.tool.id or nil,
    fgColor = colorToHex(app.fgColor),
    bgColor = colorToHex(app.bgColor),
  }

  local sprite = app.sprite
  if sprite then
    state.activeSprite = describeSprite(sprite, true)
    state.activeLayer = app.layer and layerPath(app.layer) or nil
    state.activeFrame = app.frame and app.frame.frameNumber or nil
  end
  return state
end

---------------------------------------------------------------------------
-- Snapshot
---------------------------------------------------------------------------

-- Convert a cel image of any color mode to an RGB image, using the palette.
local function toRgbImage(src, palette)
  if src.colorMode == ColorMode.RGB then return src end
  local dst = Image(src.width, src.height, ColorMode.RGB)
  if src.colorMode == ColorMode.INDEXED then
    local mask = src.spec.transparentColor
    for it in src:pixels() do
      local idx = it()
      if idx ~= mask and idx < #palette then
        local c = palette:getColor(idx)
        dst:drawPixel(it.x, it.y, app.pixelColor.rgba(c.red, c.green, c.blue, c.alpha))
      end
    end
  elseif src.colorMode == ColorMode.GRAYSCALE then
    local pc = app.pixelColor
    for it in src:pixels() do
      local v = it()
      local g, a = pc.grayaV(v), pc.grayaA(v)
      dst:drawPixel(it.x, it.y, pc.rgba(g, g, g, a))
    end
  end
  return dst
end

local function findLayer(layers, name)
  for _, l in ipairs(layers) do
    if l.name == name then return l end
    if l.isGroup then
      local found = findLayer(l.layers, name)
      if found then return found end
    end
  end
  return nil
end

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
    local layer = findLayer(sprite.layers, params.layer)
    if not layer then error("Layer not found: " .. params.layer) end
    if layer.isGroup then error("Snapshot of a group layer is not supported; snapshot the sprite instead") end
    local cel = layer:cel(frameNumber)
    if cel then
      local rgb = toRgbImage(cel.image, sprite.palettes[1])
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

---------------------------------------------------------------------------
-- execute_lua
---------------------------------------------------------------------------

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

  local env = setmetatable({ print = capturePrint }, { __index = _G })

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

local handlers = {}

handlers.ping = function()
  return { pong = true, asepriteVersion = tostring(app.version), protocol = PROTOCOL.version }
end

handlers.snapshot = function(params)
  return snapshot(params)   -- header, raw RGBA bytes
end

handlers.get_state = function()
  return getState()
end

handlers.execute_lua = function(params)
  return executeLua(params)
end

-- "#rrggbb" or "#rrggbbaa" -> Color. (Color("#...") is not supported.)
local function hexToColor(hex)
  local h = tostring(hex):gsub("^#", "")
  if not h:match("^%x+$") or (#h ~= 6 and #h ~= 8) then
    error("Invalid color: " .. tostring(hex) .. " (use #rrggbb or #rrggbbaa)")
  end
  local n = function(i) return tonumber(h:sub(i, i + 1), 16) end
  return Color(n(1), n(3), n(5), #h == 8 and n(7) or 255)
end

-- JSON values from the bridge -> Aseprite types for command params.
local function toLuaParam(v)
  if type(v) ~= "table" and type(v) ~= "userdata" then return v end
  if v.__color then return hexToColor(v.__color) end
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

local RANGE_TYPES = {
  [RangeType.EMPTY] = "empty",
  [RangeType.LAYERS] = "layers",
  [RangeType.FRAMES] = "frames",
  [RangeType.CELS] = "cels",
}

local BRUSH_TYPES = {
  [BrushType.CIRCLE] = "circle",
  [BrushType.SQUARE] = "square",
  [BrushType.LINE] = "line",
  [BrushType.IMAGE] = "image",
}

handlers.get_context = function()
  local ctx = {
    tool = app.tool and app.tool.id or nil,
    fgColor = colorToHex(app.fgColor),
    bgColor = colorToHex(app.bgColor),
  }
  local brush = app.brush
  if brush then
    ctx.brush = { size = brush.size, type = BRUSH_TYPES[brush.type] or tostring(brush.type), angle = brush.angle }
  end

  local sprite = app.sprite
  if not sprite then
    ctx.sprite = nil
    return ctx
  end
  ctx.sprite = describeSprite(sprite, false)

  local layer = app.layer
  if layer then
    ctx.layer = {
      name = layer.name,
      path = layerPath(layer),
      group = layer.isGroup,
      visible = layer.isVisible,
      editable = layer.isEditable,
      opacity = (not layer.isGroup) and layer.opacity or nil,
    }
  end
  ctx.frame = app.frame and app.frame.frameNumber or nil
  if app.tag then ctx.tag = app.tag.name end

  local cel = app.cel
  if cel then
    local b = cel.bounds
    ctx.cel = {
      layer = layerPath(cel.layer),
      frame = cel.frameNumber,
      bounds = { x = b.x, y = b.y, width = b.width, height = b.height },
      opacity = cel.opacity,
    }
  end

  local range = app.range
  if range and not range.isEmpty then
    local layers, frames = {}, {}
    for _, l in ipairs(range.layers) do layers[#layers + 1] = layerPath(l) end
    for _, f in ipairs(range.frames) do frames[#frames + 1] = f.frameNumber end
    ctx.timelineRange = {
      type = RANGE_TYPES[range.type] or tostring(range.type),
      layers = layers,
      frames = frames,
    }
  end

  local sel = sprite.selection
  if sel and not sel.isEmpty then
    local b = sel.bounds
    ctx.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  local editor = app.editor
  if editor then ctx.zoom = editor.zoom end
  return ctx
end

local MAX_READ_PIXELS = 128 * 128
local KEY_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

handlers.read_pixels = function(params)
  local sprite = app.sprite
  if not sprite then error("No active sprite") end

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
    for i = #palette - 1, 0, -1 do paletteIndex[colorToHex(palette:getColor(i))] = i end
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

-- One-line description of what the user is working on, sent with prompts.
local function contextString()
  local ok, ctx = pcall(handlers.get_context)
  if not ok or not ctx.sprite then return "no sprite open" end
  local s = ctx.sprite
  local name = app.fs.fileName(s.filename ~= "" and s.filename or "Sprite")
  local parts = { string.format("sprite %s %dx%d %s, %d frame(s)", name, s.width, s.height, s.colorMode, s.frameCount) }
  if ctx.layer then parts[#parts + 1] = "layer " .. ctx.layer.path end
  if ctx.frame then parts[#parts + 1] = "frame " .. ctx.frame end
  if ctx.tag then parts[#parts + 1] = "tag " .. ctx.tag end
  local r = ctx.timelineRange
  if r and r.type ~= "empty" then
    local frames = #r.frames > 0 and (r.frames[1] .. "-" .. r.frames[#r.frames]) or "-"
    parts[#parts + 1] = string.format("timeline selection: %s, layers [%s], frames %s", r.type, table.concat(r.layers, ", "), frames)
  end
  if ctx.selection then
    local b = ctx.selection
    parts[#parts + 1] = string.format("pixel selection x=%d y=%d %dx%d", b.x, b.y, b.width, b.height)
  end
  return table.concat(parts, "; ")
end

---------------------------------------------------------------------------
-- Interface
---------------------------------------------------------------------------

local M = {}

function M.new(opts)
  chunkDir = assert(opts and opts.chunkDir, "chunkDir required")
  PROTOCOL = assert(opts.protocol, "protocol required")

  local H = {
    handlers = handlers,
    getState = getState,
    executeLua = executeLua,
    snapshot = snapshot,
    contextString = contextString,
  }

  -- Answers one protocol request. Errors propagate to the caller.
  function H.call(method, params)
    local handler = handlers[method]
    if not handler or not PROTOCOL.requests[method] then
      error({ code = -32601, message = "Unknown method: " .. tostring(method) })
    end
    return withQuietAlerts(handler, params or {})
  end

  return H
end

return M
