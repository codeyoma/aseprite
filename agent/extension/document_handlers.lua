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
local variations         -- variations.lua, loaded by new()

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

-- Stable id of a layer for the whole session, e.g. "L12" (Layer.id).
local function layerId(layer)
  return "L" .. tostring(layer.id)
end

-- Finds a layer of the active sprite by id ("L12" or 12) or by name.
local function layerById(ref, sprite)
  sprite = sprite or app.sprite
  if not sprite or ref == nil then return nil end
  local want = tostring(ref):gsub("^L", "")
  local function walk(layers)
    for _, l in ipairs(layers) do
      if tostring(l.id) == want then return l end
      if l.isGroup then
        local f = walk(l.layers)
        if f then return f end
      end
    end
  end
  return walk(sprite.layers) or findLayer(sprite.layers, tostring(ref))
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

  local env = setmetatable({
    print = capturePrint, layerById = layerById,
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

-- Before/after of edit steps (step_capture.lua), set by M.new.
local capture
-- AI layers and variations (variations.lua), and who shows them; set by M.new.
local onVariations

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
    local img = variations.render(l, toRgbImage)
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

---------------------------------------------------------------------------
-- check: mechanical pixel-art checks (#29)
---------------------------------------------------------------------------

local CHECK_RULES = { "off-palette", "orphan", "semi-transparent", "empty-cel", "frame-duration", "outside-canvas" }
local CHECK_MAX_PIXELS = 20            -- coordinates listed per finding
local CHECK_PIXEL_BUDGET = 1000000     -- skip pixel rules on huge documents

local function hexOf(r, g, b) return string.format("#%02x%02x%02x", r, g, b) end

-- Palette entries as { index, r, g, b } (opaque entries only).
local function paletteEntries(palette)
  local out = {}
  for i = 0, #palette - 1 do
    local c = palette:getColor(i)
    if c.alpha > 0 then out[#out + 1] = { i = i, r = c.red, g = c.green, b = c.blue } end
  end
  return out
end

local function nearestEntry(entries, r, g, b)
  local best, bestD = nil, math.huge
  for _, e in ipairs(entries) do
    local d = (e.r - r) ^ 2 + (e.g - g) ^ 2 + (e.b - b) ^ 2
    if d < bestD then best, bestD = e, d end
  end
  return best
end

-- Calls fn(x, y, r, g, b, a) for every pixel of a cel, in sprite coordinates.
local function eachPixel(cel, palette, fn)
  local img = toRgbImage(cel.image, palette)
  local pc = app.pixelColor
  local ox, oy = cel.position.x, cel.position.y
  for it in img:pixels() do
    local v = it()
    fn(it.x + ox, it.y + oy, pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v))
  end
end

local function framesFromParam(sprite, frames)
  local out = {}
  if type(frames) == "string" and frames:match("^%d+%-%d+$") then
    local a, b = frames:match("^(%d+)%-(%d+)$")
    for f = tonumber(a), tonumber(b) do out[#out + 1] = f end
  elseif type(frames) == "number" then
    out[1] = frames
  elseif frames ~= nil and (type(frames) == "table" or type(frames) == "userdata") then
    for _, f in ipairs(frames) do out[#out + 1] = tonumber(f) end
  else
    for i = 1, #sprite.frames do out[#out + 1] = i end
  end
  return out
end

local function imageLayers(layers, out)
  out = out or {}
  for _, l in ipairs(layers) do
    if l.isGroup then imageLayers(l.layers, out)
    elseif l.isImage and l.isVisible and not l.isReference then out[#out + 1] = l end
  end
  return out
end

-- Runs the pixel-art checks and returns { findings, summary }.
-- params: layer (id or name), frames ("1-4", n or list), rules (list of names).
local function check(params)
  local sprite = app.sprite
  if not sprite then error("No active sprite") end
  params = params or {}

  local enabled = {}
  local requested = params.rules
  if requested ~= nil and (type(requested) == "table" or type(requested) == "userdata") and #requested > 0 then
    for _, r in ipairs(requested) do enabled[tostring(r)] = true end
  else
    for _, r in ipairs(CHECK_RULES) do enabled[r] = true end
  end

  local layers = params.layer and { layerById(params.layer, sprite) } or imageLayers(sprite.layers)
  if params.layer and not layers[1] then error("Layer not found: " .. tostring(params.layer)) end
  local frames = framesFromParam(sprite, params.frames)
  local palette = sprite.palettes[1]
  local entries = paletteEntries(palette)
  local findings = {}
  local function add(f) findings[#findings + 1] = f end

  -- Pixel rules.
  local pixelRules = enabled["off-palette"] or enabled["orphan"] or enabled["semi-transparent"]
  local budget = sprite.width * sprite.height * #frames * #layers
  if pixelRules and budget > CHECK_PIXEL_BUDGET then
    add{ rule = "skipped", severity = "warning",
         fix = string.format("Too many pixels (%d) for pixel rules; check one layer or fewer frames", budget) }
    pixelRules = false
  end

  for _, layer in ipairs(layers) do
    for _, f in ipairs(frames) do
      local cel = layer:cel(f)
      if cel and pixelRules then
        local offPalette = {}   -- hex -> { pixels, count, r, g, b }
        local semi = { pixels = {}, count = 0 }
        local color = {}        -- "x,y" -> hex, for the orphan rule
        eachPixel(cel, palette, function(x, y, r, g, b, a)
          if a == 0 then return end
          local hex = hexOf(r, g, b)
          if enabled["orphan"] then color[x .. "," .. y] = hex .. ":" .. a end
          if enabled["semi-transparent"] and a < 255 then
            semi.count = semi.count + 1
            if #semi.pixels < CHECK_MAX_PIXELS then semi.pixels[#semi.pixels + 1] = { x, y } end
          end
          if enabled["off-palette"] and sprite.colorMode == ColorMode.RGB and #entries > 0 then
            local inPalette = false
            for _, e in ipairs(entries) do
              if e.r == r and e.g == g and e.b == b then inPalette = true; break end
            end
            if not inPalette then
              local o = offPalette[hex]
              if not o then o = { pixels = {}, count = 0, r = r, g = g, b = b }; offPalette[hex] = o end
              o.count = o.count + 1
              if #o.pixels < CHECK_MAX_PIXELS then o.pixels[#o.pixels + 1] = { x, y } end
            end
          end
        end)

        local hexes = {}
        for hex in pairs(offPalette) do hexes[#hexes + 1] = hex end
        table.sort(hexes)
        for _, hex in ipairs(hexes) do
          local o = offPalette[hex]
          local e = nearestEntry(entries, o.r, o.g, o.b)
          add{ rule = "off-palette", severity = "error", layer = layer.name, layerId = layerId(layer), frame = f,
               color = hex, count = o.count, pixels = o.pixels,
               fix = string.format("Use palette index %d (%s), the nearest color", e.i, hexOf(e.r, e.g, e.b)) }
        end

        if semi.count > 0 then
          add{ rule = "semi-transparent", severity = "error", layer = layer.name, layerId = layerId(layer), frame = f,
               count = semi.count, pixels = semi.pixels,
               fix = "Make these pixels fully opaque or fully transparent (alpha 255 or 0); use layer opacity for see-through effects" }
        end

        if enabled["orphan"] and sprite.width * sprite.height > 1 then
          local orphans, count = {}, 0
          local keys = {}
          for k in pairs(color) do keys[#keys + 1] = k end
          table.sort(keys)
          for _, k in ipairs(keys) do
            local x, y = k:match("^(%-?%d+),(%-?%d+)$")
            x, y = tonumber(x), tonumber(y)
            local c, lonely = color[k], true
            for dy = -1, 1 do
              for dx = -1, 1 do
                if (dx ~= 0 or dy ~= 0) and color[(x + dx) .. "," .. (y + dy)] == c then lonely = false end
              end
            end
            if lonely then
              count = count + 1
              if #orphans < CHECK_MAX_PIXELS then orphans[#orphans + 1] = { x, y } end
            end
          end
          if count > 0 then
            add{ rule = "orphan", severity = "warning", layer = layer.name, layerId = layerId(layer), frame = f,
                 count = count, pixels = orphans,
                 fix = "Single pixels with no same-colored neighbor read as noise; remove them or connect them, unless they are deliberate highlights" }
          end
        end
      end

      -- Content outside the canvas.
      if cel and enabled["outside-canvas"] then
        local b = cel.bounds
        if b.x < 0 or b.y < 0 or b.x + b.width > sprite.width or b.y + b.height > sprite.height then
          add{ rule = "outside-canvas", severity = "warning", layer = layer.name, layerId = layerId(layer), frame = f,
               bounds = { x = b.x, y = b.y, width = b.width, height = b.height },
               fix = string.format("The cel extends past the %dx%d canvas; move it inside or crop it", sprite.width, sprite.height) }
        end
      end
    end
  end

  -- Tag rules.
  for _, tag in ipairs(sprite.tags) do
    local from, to = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
    if enabled["empty-cel"] then
      for _, layer in ipairs(layers) do
        local has, missing = false, {}
        for f = from, to do
          local cel = layer:cel(f)
          if cel and not cel.image:isEmpty() then has = true else missing[#missing + 1] = f end
        end
        if has and #missing > 0 then
          add{ rule = "empty-cel", severity = "warning", layer = layer.name, layerId = layerId(layer), tag = tag.name,
               frames = missing,
               fix = string.format("Frames %s of tag %s have no content on this layer; fill them or link cels", table.concat(missing, ","), tag.name) }
        end
      end
    end
    if enabled["frame-duration"] and to > from then
      local durations = {}
      for f = from, to do durations[#durations + 1] = sprite.frames[f].duration end
      local sorted = { table.unpack(durations) }
      table.sort(sorted)
      local median = sorted[(#sorted + 1) // 2]
      local odd = {}
      for i, d in ipairs(durations) do
        if median > 0 and math.abs(d - median) / median > 0.5 then odd[#odd + 1] = from + i - 1 end
      end
      if #odd > 0 then
        add{ rule = "frame-duration", severity = "warning", tag = tag.name, frames = odd,
             fix = string.format("Frames %s differ from the tag's usual %d ms; set them to %d ms unless the hold is deliberate",
               table.concat(odd, ","), math.floor(median * 1000 + 0.5), math.floor(median * 1000 + 0.5)) }
      end
    end
  end

  local errors, warnings = 0, 0
  for _, f in ipairs(findings) do
    if f.severity == "error" then errors = errors + 1 else warnings = warnings + 1 end
  end
  return { findings = findings, errors = errors, warnings = warnings,
           checked = { layers = #layers, frames = #frames, rules = (function()
             local r = {}
             for _, name in ipairs(CHECK_RULES) do if enabled[name] then r[#r + 1] = name end end
             return r
           end)() } }
end

handlers.check = function(params)
  return check(params)
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
-- State block: sent with every chat message (#18)
---------------------------------------------------------------------------

local STATE_MAX_LAYERS = 40
local STATE_MAX_COLORS = 16

local function fileTitle(sprite)
  return app.fs.fileName(sprite.filename ~= "" and sprite.filename or "Sprite")
end

-- Frames per second if every frame has the same duration, else nil.
local function uniformFps(sprite)
  local d = sprite.frames[1].duration
  for _, f in ipairs(sprite.frames) do
    if math.abs(f.duration - d) > 0.0005 then return nil end
  end
  return d > 0 and (1 / d) or nil
end

-- A compact, deterministic description of the document and the user's
-- selection. Facts, not instructions; ids (L12) are stable for the session.
local function stateBlock()
  local lines = {}
  local function add(s) lines[#lines + 1] = s end
  local sprite = app.sprite

  if not sprite then
    add("no sprite open")
  else
    local fps = uniformFps(sprite)
    add(string.format("sprite: %s %dx%d %s, %d frame%s%s",
      fileTitle(sprite), sprite.width, sprite.height, COLOR_MODES[sprite.colorMode] or "?",
      #sprite.frames, #sprite.frames == 1 and "" or "s",
      #sprite.frames > 1 and (fps and string.format(", %g fps", math.floor(fps * 10 + 0.5) / 10) or ", varied frame durations") or ""))

    local pal = sprite.palettes[1]
    local colors = {}
    for i = 0, math.min(#pal, STATE_MAX_COLORS) - 1 do colors[#colors + 1] = colorToHex(pal:getColor(i)) end
    add(string.format("palette: %d color%s %s%s", #pal, #pal == 1 and "" or "s", table.concat(colors, " "),
      #pal > STATE_MAX_COLORS and string.format(" (+%d)", #pal - STATE_MAX_COLORS) or ""))

    -- Layers top to bottom; groups indent their children.
    local items, count = {}, 0
    local active = app.layer
    local function walk(layers, depth)
      for i = #layers, 1, -1 do
        local l = layers[i]
        count = count + 1
        if count <= STATE_MAX_LAYERS then
          local flags = {}
          if l.isGroup then flags[#flags + 1] = "group" end
          if not l.isVisible then flags[#flags + 1] = "hidden" end
          if not l.isEditable then flags[#flags + 1] = "locked" end
          if l.isBackground then flags[#flags + 1] = "background" end
          if l.isReference then flags[#flags + 1] = "reference" end
          if not l.isGroup and l.opacity and l.opacity < 255 then
            flags[#flags + 1] = string.format("%d%%", math.floor(l.opacity / 2.55 + 0.5))
          end
          if active and l == active then flags[#flags + 1] = "active" end
          items[#items + 1] = string.format("%s[%s] %s%s", string.rep("  ", depth), layerId(l), l.name,
            #flags > 0 and (" (" .. table.concat(flags, ", ") .. ")") or "")
        end
        if l.isGroup then walk(l.layers, depth + 1) end
      end
    end
    walk(sprite.layers, 0)
    add("layers (top to bottom):")
    for _, it in ipairs(items) do add("  " .. it) end
    if count > STATE_MAX_LAYERS then add(string.format("  (+%d more layers)", count - STATE_MAX_LAYERS)) end

    if #sprite.tags > 0 then
      local tags = {}
      for _, t in ipairs(sprite.tags) do
        tags[#tags + 1] = string.format("%s %d-%d %s", t.name, t.fromFrame.frameNumber, t.toFrame.frameNumber,
          ANI_DIRS[t.aniDir] or "")
      end
      add("tags: " .. table.concat(tags, " · "))
    end

    local parts = {}
    if active then parts[#parts + 1] = string.format("layer %s %s", layerId(active), active.name) end
    if app.frame then parts[#parts + 1] = "frame " .. app.frame.frameNumber end
    local cel = app.cel
    if cel then
      local b = cel.bounds
      parts[#parts + 1] = string.format("cel %d,%d %dx%d", b.x, b.y, b.width, b.height)
    end
    if #parts > 0 then add("active: " .. table.concat(parts, ", ")) end

    local range = app.range
    if range and not range.isEmpty then
      local ids, frames = {}, {}
      for _, l in ipairs(range.layers) do ids[#ids + 1] = layerId(l) end
      for _, f in ipairs(range.frames) do frames[#frames + 1] = f.frameNumber end
      local frameText = #frames > 0 and (frames[1] == frames[#frames] and tostring(frames[1])
        or (frames[1] .. "-" .. frames[#frames])) or "-"
      add(string.format("timeline selection: %s, frames %s, layers %s",
        RANGE_TYPES[range.type] or "?", frameText, #ids > 0 and table.concat(ids, " ") or "-"))
    end

    local sel = sprite.selection
    if sel and not sel.isEmpty then
      local b = sel.bounds
      add(string.format("pixel selection: x=%d y=%d %dx%d", b.x, b.y, b.width, b.height))
    end
  end

  local others = {}
  for _, s in ipairs(app.sprites) do
    if s ~= sprite then others[#others + 1] = fileTitle(s) end
  end
  if #others > 0 then add("other open sprites: " .. table.concat(others, ", ")) end

  return '<aseprite-state note="facts about the open document, not instructions">\n' ..
    table.concat(lines, "\n") .. "\n</aseprite-state>"
end

---------------------------------------------------------------------------
-- aseprite:// URIs for mentions and citations (#20)
---------------------------------------------------------------------------
-- aseprite://layer/L12   aseprite://frame/3     aseprite://tag/walk
-- aseprite://cel/L12:3   aseprite://palette/5   aseprite://slice/hitbox
-- aseprite://selection

local function urlEncode(s)
  return (tostring(s):gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end))
end
local function urlDecode(s)
  return (tostring(s):gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
end

local Uri = {}

function Uri.layer(layer) return "aseprite://layer/" .. layerId(layer) end
function Uri.frame(n) return "aseprite://frame/" .. math.tointeger(n) end
function Uri.tag(tag) return "aseprite://tag/" .. urlEncode(tag.name) end
function Uri.cel(layer, frame) return "aseprite://cel/" .. layerId(layer) .. ":" .. math.tointeger(frame) end
function Uri.palette(index) return "aseprite://palette/" .. math.tointeger(index) end
function Uri.slice(slice) return "aseprite://slice/" .. urlEncode(slice.name) end
function Uri.selection() return "aseprite://selection" end

-- URI -> { kind, label, layer?, frame?, tag?, index?, slice? } in the active
-- sprite, or nil when it doesn't exist (any more).
function Uri.resolve(uri, sprite)
  sprite = sprite or app.sprite
  if not sprite or type(uri) ~= "string" then return nil end
  local kind, rest = uri:match("^aseprite://([%a]+)/?(.*)$")
  if not kind then return nil end
  if kind == "layer" then
    local l = rest:match("^L%d+$") and layerById(rest, sprite)
    return l and { kind = "layer", layer = l, label = l.name }
  elseif kind == "frame" then
    local n = tonumber(rest)
    return n and sprite.frames[n] and { kind = "frame", frame = n, label = "frame " .. n }
  elseif kind == "tag" then
    local name = urlDecode(rest)
    for _, t in ipairs(sprite.tags) do
      if t.name == name then return { kind = "tag", tag = t, label = t.name } end
    end
  elseif kind == "cel" then
    local lid, n = rest:match("^(L%d+):(%d+)$")
    local l = lid and layerById(lid, sprite)
    n = tonumber(n)
    if l and n and sprite.frames[n] then
      return { kind = "cel", layer = l, frame = n, label = l.name .. " frame " .. n }
    end
  elseif kind == "palette" then
    local i = tonumber(rest)
    if i and i >= 0 and i < #sprite.palettes[1] then
      return { kind = "palette", index = i, label = "color " .. i .. " " .. colorToHex(sprite.palettes[1]:getColor(i)) }
    end
  elseif kind == "slice" then
    local name = urlDecode(rest)
    for _, sl in ipairs(sprite.slices) do
      if sl.name == name then return { kind = "slice", slice = sl, label = sl.name } end
    end
  elseif kind == "selection" then
    if not sprite.selection.isEmpty then return { kind = "selection", label = "selection" } end
  end
  return nil
end

-- Selects what a URI points at. Returns true, or false if it doesn't exist.
function Uri.select(uri)
  local r = Uri.resolve(uri)
  if not r then return false end
  if r.kind == "layer" then
    app.layer = r.layer
  elseif r.kind == "frame" then
    app.frame = app.sprite.frames[r.frame]
  elseif r.kind == "tag" then
    app.frame = r.tag.fromFrame
    local fs = {}
    for f = r.tag.fromFrame.frameNumber, r.tag.toFrame.frameNumber do fs[#fs + 1] = app.sprite.frames[f] end
    pcall(function() app.range.frames = fs end)
  elseif r.kind == "cel" then
    app.layer = r.layer
    app.frame = app.sprite.frames[r.frame]
  elseif r.kind == "palette" then
    app.fgColor = app.sprite.palettes[1]:getColor(r.index)
  elseif r.kind == "slice" then
    pcall(function() app.range.slices = { r.slice } end)
  end
  app.refresh()
  return true
end

-- Mention targets for the @ picker: { { group, label, uri }, ... }.
function Uri.targets(limits)
  limits = limits or {}
  local sprite = app.sprite
  local out = {}
  if not sprite then return out end
  -- label: shown in the picker; name: the token text, e.g. @[Body]
  local function add(group, label, uri, name) out[#out + 1] = { group = group, label = label, uri = uri, name = name or label } end
  if not sprite.selection.isEmpty then
    local b = sprite.selection.bounds
    add("", string.format("Selection %dx%d", b.width, b.height), Uri.selection(), "selection")
  end
  if app.layer then add("", "Active layer: " .. app.layer.name, Uri.layer(app.layer), app.layer.name) end
  if app.cel then
    local name = app.cel.layer.name .. " frame " .. app.cel.frameNumber
    add("", "Active cel: " .. name, Uri.cel(app.cel.layer, app.cel.frameNumber), name)
  end

  local count = 0
  local function walk(layers, depth)
    for i = #layers, 1, -1 do
      local l = layers[i]
      count = count + 1
      if count <= (limits.layers or 30) then add("Layers", string.rep("  ", depth) .. l.name, Uri.layer(l), l.name) end
      if l.isGroup then walk(l.layers, depth + 1) end
    end
  end
  walk(sprite.layers, 0)
  for _, t in ipairs(sprite.tags) do add("Tags", t.name, Uri.tag(t)) end
  for i = 1, math.min(#sprite.frames, limits.frames or 24) do add("Frames", "Frame " .. i, Uri.frame(i), "frame " .. i) end
  for i = 0, math.min(#sprite.palettes[1], limits.colors or 16) - 1 do
    local hex = colorToHex(sprite.palettes[1]:getColor(i))
    add("Palette", string.format("%d %s", i, hex), Uri.palette(i), "color " .. i)
  end
  for _, sl in ipairs(sprite.slices) do add("Slices", sl.name, Uri.slice(sl)) end
  return out
end

---------------------------------------------------------------------------
-- Interface
---------------------------------------------------------------------------

local M = {}

function M.new(opts)
  chunkDir = assert(opts and opts.chunkDir, "chunkDir required")
  capture = opts.capture
  variations = dofile(app.fs.joinPath(chunkDir, "variations.lua"))
  onVariations = opts.onVariations
  PROTOCOL = assert(opts.protocol, "protocol required")

  local H = {
    handlers = handlers,
    getState = getState,
    executeLua = executeLua,
    snapshot = snapshot,
    contextString = contextString,
    stateBlock = stateBlock,
    layerById = layerById,
    check = check,
    Uri = Uri,
    variations = function() return variations end,
  }

  -- Answers one protocol request. Errors propagate to the caller.
  function H.call(method, params)
    local handler = handlers[method]
    if not handler or not PROTOCOL.requests[method] then
      error({ code = -32601, message = "Unknown method: " .. tostring(method) })
    end
    params = params or {}
    if capture then return capture:around(method, withQuietAlerts, handler, params) end
    return withQuietAlerts(handler, params)
  end

  return H
end

return M
