-- Document View: how the extension describes the open document, read-only.
-- Layer ids and paths, the sprite description get_state returns, the
-- context the user is working in, the State block sent with every chat
-- message, and aseprite:// URIs for mentions and citations. The Document
-- Handlers answer wire requests with it; the chat panel shows it.
--
--   local View = dofile("document_view.lua").new{ px = dofile("pixels.lua") }
--   View.stateBlock()                 -- "<aseprite-state ...>...</aseprite-state>"
--   View.layerById("L12")             -- a layer of the active sprite, by id or name
--   View.Uri.resolve("aseprite://frame/3")

local M = {}

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

local RANGE_TYPES = {
  [RangeType.EMPTY] = "empty",
  [RangeType.LAYERS] = "layers",
  [RangeType.FRAMES] = "frames",
  [RangeType.CELS] = "cels",
}

-- Layer blend modes by their wire names (protocol.json blendModes), both ways.
local BLEND_MODES = {
  normal = BlendMode.NORMAL, multiply = BlendMode.MULTIPLY, screen = BlendMode.SCREEN,
  overlay = BlendMode.OVERLAY, darken = BlendMode.DARKEN, lighten = BlendMode.LIGHTEN,
  color_dodge = BlendMode.COLOR_DODGE, color_burn = BlendMode.COLOR_BURN,
  hard_light = BlendMode.HARD_LIGHT, soft_light = BlendMode.SOFT_LIGHT,
  difference = BlendMode.DIFFERENCE, exclusion = BlendMode.EXCLUSION,
  hue = BlendMode.HSL_HUE, saturation = BlendMode.HSL_SATURATION, color = BlendMode.HSL_COLOR,
  luminosity = BlendMode.HSL_LUMINOSITY, addition = BlendMode.ADDITION,
  subtract = BlendMode.SUBTRACT, divide = BlendMode.DIVIDE,
}
local BLEND_NAMES = {}
for name, mode in pairs(BLEND_MODES) do BLEND_NAMES[mode] = name end

local BRUSH_TYPES = {
  [BrushType.CIRCLE] = "circle",
  [BrushType.SQUARE] = "square",
  [BrushType.LINE] = "line",
  [BrushType.IMAGE] = "image",
}

M.COLOR_MODES = COLOR_MODES
M.ANI_DIRS = ANI_DIRS

local STATE_MAX_LAYERS = 40
local STATE_MAX_COLORS = 16

local function typeName(v)
  local mt = getmetatable(v)
  return mt and mt.__name or type(v)
end
M.typeName = typeName

local function urlEncode(s)
  return (tostring(s):gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end))
end
local function urlDecode(s)
  return (tostring(s):gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
end

-- opts.px: pixels.lua (hex colors).
function M.new(opts)
  local px = assert(opts and opts.px, "px (pixels.lua) required")
  local V = { COLOR_MODES = COLOR_MODES, ANI_DIRS = ANI_DIRS, BLEND_MODES = BLEND_MODES, typeName = typeName }

  -------------------------------------------------------------------------
  -- Layers
  -------------------------------------------------------------------------

  -- Stable id of a layer for the whole session, e.g. "L12" (Layer.id).
  function V.layerId(layer)
    return "L" .. tostring(layer.id)
  end
  local layerId = V.layerId

  -- "Group/Sub/Layer" path of a layer, for nested groups.
  function V.layerPath(layer)
    local parts = { layer.name }
    local p = layer.parent
    while p and typeName(p) == "Layer" do
      table.insert(parts, 1, p.name)
      p = p.parent
    end
    return table.concat(parts, "/")
  end
  local layerPath = V.layerPath

  -- A layer by name, searched through groups, top first.
  function V.findLayer(layers, name)
    for _, l in ipairs(layers) do
      if l.name == name then return l end
      if l.isGroup then
        local found = V.findLayer(l.layers, name)
        if found then return found end
      end
    end
    return nil
  end

  -- Finds a layer of the active sprite by id ("L12" or 12) or by name.
  function V.layerById(ref, sprite)
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
    return walk(sprite.layers) or V.findLayer(sprite.layers, tostring(ref))
  end
  local layerById = V.layerById

  -------------------------------------------------------------------------
  -- Sprite description (get_state)
  -------------------------------------------------------------------------

  local function describeLayers(layers)
    local out = {}
    -- Top-most layer first, as in the timeline.
    for i = #layers, 1, -1 do
      local l = layers[i]
      local item = {
        id = layerId(l),
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
        item.blendMode = BLEND_NAMES[l.blendMode] or tostring(l.blendMode)
        item.tilemap = l.isTilemap or nil
        item.background = l.isBackground or nil
        item.reference = l.isReference or nil
        local cels, byImage, links = {}, {}, {}
        for _, cel in ipairs(l.cels) do
          cels[#cels + 1] = cel.frameNumber
          -- Linked cels share one image: celLinks lists each group of 2+ frames (#70).
          local id = cel.image.id
          if byImage[id] then
            if #byImage[id] == 1 then links[#links + 1] = byImage[id] end
            table.insert(byImage[id], cel.frameNumber)
          else
            byImage[id] = { cel.frameNumber }
          end
        end
        item.celFrames = cels
        if #links > 0 then item.celLinks = links end
        -- An effect recorded by the FX tools (#71): the layer property aseprite-agent "fx".
        local fx = l.properties("aseprite-agent").fx
        if type(fx) == "table" and fx.id then
          item.fx = { id = fx.id, x = fx.x, y = fx.y, fps = fx.fps, loop = fx.loop, windupMs = fx.windupMs,
            recipe = fx.recipe, render = fx.render }
        end
      end
      out[#out + 1] = item
    end
    return out
  end

  function V.describeSprite(sprite, full)
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
      colors[#colors + 1] = px.colorHex(pal:getColor(i))
    end
    info.palette = { size = #pal, colors = colors }

    -- Slices with their 9-patch centers (#61).
    local slices = {}
    for _, sl in ipairs(sprite.slices) do
      local b, c = sl.bounds, sl.center
      slices[#slices + 1] = {
        name = sl.name,
        bounds = b and { x = b.x, y = b.y, width = b.width, height = b.height } or nil,
        center = c and { x = c.x, y = c.y, width = c.width, height = c.height } or nil,
      }
    end
    if #slices > 0 then info.slices = slices end

    -- Hits recorded by hit_stop (#70): the sprite property aseprite-agent "fx.hits".
    local hits = {}
    for _, h in ipairs(sprite.properties("aseprite-agent")["fx.hits"] or {}) do
      hits[#hits + 1] = { frame = h.frame, freezeMs = h.freezeMs, shakeMs = h.shakeMs, amp = h.amp }
    end
    if #hits > 0 then info.fxHits = hits end

    -- A pixel spec stored by the concept tools (#79): the sprite property aseprite-agent "concept.spec".
    local spec = sprite.properties("aseprite-agent")["concept.spec"]
    if type(spec) == "string" and spec ~= "" then info.pixelSpec = spec end

    local sel = sprite.selection
    if sel and not sel.isEmpty then
      local b = sel.bounds
      info.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
    end

    return info
  end
  local describeSprite = V.describeSprite

  -- The get_state result: open sprites, the active one in full.
  function V.getState()
    local sprites = {}
    for _, s in ipairs(app.sprites) do
      sprites[#sprites + 1] = describeSprite(s, false)
    end

    local state = {
      asepriteVersion = tostring(app.version),
      apiVersion = app.apiVersion,
      openSprites = sprites,
      tool = app.tool and app.tool.id or nil,
      fgColor = px.colorHex(app.fgColor),
      bgColor = px.colorHex(app.bgColor),
    }

    local sprite = app.sprite
    if sprite then
      state.activeSprite = describeSprite(sprite, true)
      state.activeLayer = app.layer and layerPath(app.layer) or nil
      state.activeLayerId = app.layer and layerId(app.layer) or nil
      state.activeFrame = app.frame and app.frame.frameNumber or nil
    end
    return state
  end

  -------------------------------------------------------------------------
  -- Context: what the user is working on (get_context, the context line)
  -------------------------------------------------------------------------

  function V.getContext()
    local ctx = {
      tool = app.tool and app.tool.id or nil,
      fgColor = px.colorHex(app.fgColor),
      bgColor = px.colorHex(app.bgColor),
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

    -- Hits recorded by hit_stop (#70): the sprite property aseprite-agent "fx.hits".
    local hits = {}
    for _, h in ipairs(sprite.properties("aseprite-agent")["fx.hits"] or {}) do
      hits[#hits + 1] = { frame = h.frame, freezeMs = h.freezeMs, shakeMs = h.shakeMs, amp = h.amp }
    end
    if #hits > 0 then info.fxHits = hits end

    local sel = sprite.selection
    if sel and not sel.isEmpty then
      local b = sel.bounds
      ctx.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
    end

    local editor = app.editor
    if editor then ctx.zoom = editor.zoom end
    return ctx
  end

  -- One-line description of what the user is working on, sent with prompts.
  function V.contextString()
    local ok, ctx = pcall(V.getContext)
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

  -------------------------------------------------------------------------
  -- State block: sent with every chat message (#18)
  -------------------------------------------------------------------------

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
  function V.stateBlock()
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
      for i = 0, math.min(#pal, STATE_MAX_COLORS) - 1 do colors[#colors + 1] = px.colorHex(pal:getColor(i)) end
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

  -------------------------------------------------------------------------
  -- aseprite:// URIs for mentions and citations (#20)
  -------------------------------------------------------------------------
  -- aseprite://layer/L12   aseprite://frame/3     aseprite://tag/walk
  -- aseprite://cel/L12:3   aseprite://palette/5   aseprite://slice/hitbox
  -- aseprite://selection

  local Uri = {}
  V.Uri = Uri

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
        return { kind = "palette", index = i, label = "color " .. i .. " " .. px.colorHex(sprite.palettes[1]:getColor(i)) }
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
      local hex = px.colorHex(sprite.palettes[1]:getColor(i))
      add("Palette", string.format("%d %s", i, hex), Uri.palette(i), "color " .. i)
    end
    for _, sl in ipairs(sprite.slices) do add("Slices", sl.name, Uri.slice(sl)) end
    return out
  end

  return V
end

return M
