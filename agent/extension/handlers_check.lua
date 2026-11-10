-- Check area (#29): mechanical pixel-art checks, the `check` request.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_check.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua

return function(handlers, D)
  local px, layerById, layerId = D.px, D.layerById, D.view.layerId
  local framesFromParam, imageLayers, wireParams = D.framesFromParam, D.imageLayers, D.wireParams

  local CHECK_RULES = { "off-palette", "orphan", "semi-transparent", "empty-cel", "frame-duration", "outside-canvas",
                        "duplicate-frame", "ground-jitter" }
  local CHECK_MAX_PIXELS = 20            -- coordinates listed per finding
  local CHECK_PIXEL_BUDGET = 1000000     -- skip pixel rules on huge documents

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

  local EXPECT_KEYS = { layer_frames = true, must_not_overlap = true }
  local OPAQUE = 128   -- alpha at which a pixel counts as art for overlaps (as the bridge's image.ts)

  local function isList(v) return type(v) == "table" and (next(v) == nil or v[1] ~= nil) end
  local function isObject(v) return type(v) == "table" and v[1] == nil end

  -- A layer reference from expect, resolved as the wire resolves layer params (wire_params.lua).
  local function expectLayer(ref, sprite, where)
    if type(ref) ~= "string" and type(ref) ~= "number" then
      error(string.format("check: %s must be a layer id or name", where))
    end
    local layer = layerById(ref, sprite)
    if not layer then error("Layer not found: " .. tostring(ref)) end
    return layer
  end

  -- The image layers that make up a named layer: itself, or a group's visible image layers.
  local function members(layer)
    if layer.isGroup then return imageLayers(layer.layers) end
    return { layer }
  end

  local function hasArt(layers, f)
    for _, l in ipairs(layers) do
      local cel = l:cel(f)
      if cel and not cel.image:isEmpty() then return true end
    end
    return false
  end

  -- "x,y" -> true for the pixels with alpha >= OPAQUE on these layers in frame f.
  local function opaqueSet(layers, f, palette)
    local set = {}
    for _, l in ipairs(layers) do
      local cel = l:cel(f)
      if cel then
        px.eachPixel(cel, palette, function(x, y, _, _, _, a)
          if a >= OPAQUE then set[x .. "," .. y] = { x, y } end
        end)
      end
    end
    return set
  end

  -- Checks expect's shape and resolves its layers and frame ranges.
  -- Returns { layerFrames = { {layer, frames} }, overlaps = { {a, b} } }.
  local function parseExpect(expect, sprite)
    if not isObject(expect) then error("check: 'expect' must be an object") end
    for k in pairs(expect) do
      if not EXPECT_KEYS[k] then
        error(string.format("check: unknown expectation '%s' (use layer_frames or must_not_overlap)", tostring(k)))
      end
    end
    local out = { layerFrames = {}, overlaps = {} }
    if expect.layer_frames ~= nil then
      if not isObject(expect.layer_frames) then
        error("check: layer_frames must be an object of layer -> frames, e.g. { Weapon = '3-5' }")
      end
      local refs = {}
      for ref in pairs(expect.layer_frames) do refs[#refs + 1] = ref end
      table.sort(refs, function(a, b) return tostring(a) < tostring(b) end)
      for _, ref in ipairs(refs) do
        local layer = expectLayer(ref, sprite, "a layer_frames key")
        local spec = expect.layer_frames[ref]
        local ok, frames = pcall(wireParams.resolveFrames, spec, #sprite.frames, 1, nil)
        if not ok or not frames then
          error(string.format("check: layer_frames for %s: %s", tostring(ref),
            ok and "frames are required" or tostring(frames):gsub("^.-:%d+: ", "")))
        end
        out.layerFrames[#out.layerFrames + 1] = { layer = layer, frames = frames }
      end
    end
    if expect.must_not_overlap ~= nil then
      if not isList(expect.must_not_overlap) then
        error("check: must_not_overlap must be a list of layer pairs, e.g. [['Weapon', 'Head']]")
      end
      for i, pair in ipairs(expect.must_not_overlap) do
        if not isList(pair) or #pair ~= 2 then
          error(string.format("check: must_not_overlap[%d] must be a pair of layers", i))
        end
        local a = expectLayer(pair[1], sprite, string.format("must_not_overlap[%d][1]", i))
        local b = expectLayer(pair[2], sprite, string.format("must_not_overlap[%d][2]", i))
        if a == b then error(string.format("check: must_not_overlap[%d] names %s twice", i, a.name)) end
        out.overlaps[#out.overlaps + 1] = { a = a, b = b }
      end
    end
    return out
  end

  local function rangeText(frames)
    local parts, i = {}, 1
    while i <= #frames do
      local j = i
      while j < #frames and frames[j + 1] == frames[j] + 1 do j = j + 1 end
      parts[#parts + 1] = i == j and tostring(frames[i]) or (frames[i] .. "-" .. frames[j])
      i = j + 1
    end
    return table.concat(parts, ",")
  end

  -- Stated expectations (#80): which frames a layer holds art in, and layer pairs
  -- that must never share an opaque pixel (a blade through the face). Adapted from
  -- the `expect` option of aseprite-ai-artist's validate (MIT).
  local function checkExpect(expect, sprite, frames, palette, add)
    for _, e in ipairs(expect.layerFrames) do
      local layer, set = e.layer, {}
      for _, f in ipairs(e.frames) do set[f] = true end
      local parts = members(layer)
      local outside, missing = {}, {}
      for _, f in ipairs(frames) do
        local art = hasArt(parts, f)
        if art and not set[f] then outside[#outside + 1] = f end
        if not art and set[f] then missing[#missing + 1] = f end
      end
      local range = rangeText(e.frames)
      if #outside > 0 then
        add{ rule = "layer-frames", severity = "error", layer = layer.name, layerId = layerId(layer), frames = outside,
             fix = string.format("%s has art in frames %s but should only show in %s; clear those cels, or state the range it really has",
               layer.name, table.concat(outside, ","), range) }
      end
      if #missing > 0 then
        add{ rule = "layer-frames", severity = "error", layer = layer.name, layerId = layerId(layer), frames = missing,
             fix = string.format("%s has no art in frames %s of its range %s; draw it there or link the cel from a neighboring frame",
               layer.name, table.concat(missing, ","), range) }
      end
    end
    for _, o in ipairs(expect.overlaps) do
      local pa, pb = members(o.a), members(o.b)
      for _, f in ipairs(frames) do
        if hasArt(pa, f) and hasArt(pb, f) then
          local setA = opaqueSet(pa, f, palette)
          local both = {}
          for k, p in pairs(opaqueSet(pb, f, palette)) do if setA[k] then both[#both + 1] = p end end
          if #both > 0 then
            table.sort(both, function(p, q) return p[2] < q[2] or (p[2] == q[2] and p[1] < q[1]) end)
            local pixels = {}
            for i = 1, math.min(#both, CHECK_MAX_PIXELS) do pixels[i] = both[i] end
            add{ rule = "overlap", severity = "error", layer = o.a.name, layerId = layerId(o.a),
                 other = o.b.name, otherId = layerId(o.b), frame = f, count = #both, pixels = pixels,
                 fix = string.format("%s and %s cross in frame %d; move or redraw one so they share no pixels (pass the %s in front of or behind the %s, not through it)",
                   o.a.name, o.b.name, f, o.a.name, o.b.name) }
          end
        end
      end
    end
  end

  -- Runs the pixel-art checks and returns { findings, summary }.
  -- params: layer (id or name), frames ("1-4", n or list), rules (list of names),
  -- expect ({ layer_frames = { [layer] = frames }, must_not_overlap = { {a, b} } }).
  local function check(params)
    local sprite = app.sprite
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
    -- Expectations are checked first, so a malformed one fails before any work.
    local expect = params.expect ~= nil and parseExpect(params.expect, sprite) or nil

    -- Pixel rules.
    local pixelRules = enabled["off-palette"] or enabled["orphan"] or enabled["semi-transparent"]
    local budget = sprite.width * sprite.height * #frames * #layers
    if pixelRules and budget > CHECK_PIXEL_BUDGET then
      add{ rule = "skipped", severity = "warning",
           fix = string.format("Too many pixels (%d) for pixel rules; check one layer or fewer frames", budget) }
      pixelRules = false
    end

    -- Light layers (#69): a layer that does not blend Normal (an Addition glow, a Multiply shadow) is light
    -- or shade over the art, not pixels of it, so the per-pixel rules skip it.
    local lightLayers = {}
    for _, layer in ipairs(layers) do
      if layer.blendMode ~= BlendMode.NORMAL then lightLayers[#lightLayers + 1] = layer.name end
    end

    for _, layer in ipairs(layers) do
      local pixelRulesHere = pixelRules and layer.blendMode == BlendMode.NORMAL
      for _, f in ipairs(frames) do
        local cel = layer:cel(f)
        if cel and pixelRulesHere then
          local offPalette = {}   -- hex -> { pixels, count, r, g, b }
          local semi = { pixels = {}, count = 0 }
          local color = {}        -- "x,y" -> hex, for the orphan rule
          px.eachPixel(cel, palette, function(x, y, r, g, b, a)
            if a == 0 then return end
            local hex = px.hex(r, g, b)
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
                 fix = string.format("Use palette index %d (%s), the nearest color", e.i, px.hex(e.r, e.g, e.b)) }
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

    -- Animation rules (#42): frames that repeat inside a tag, and feet that
    -- jitter (the lowest row moves by 1-3 px; more is deliberate motion).
    if enabled["duplicate-frame"] or enabled["ground-jitter"] then
      local cache = {}
      local function composite(f)
        if not cache[f] then
          local img = Image(sprite.width, sprite.height, ColorMode.RGB)
          img:drawSprite(sprite, f)
          cache[f] = img
        end
        return cache[f]
      end
      local function lowestRow(img)
        for y = img.height - 1, 0, -1 do
          for x = 0, img.width - 1 do
            if app.pixelColor.rgbaA(img:getPixel(x, y)) > 0 then return y end
          end
        end
      end
      for _, tag in ipairs(sprite.tags) do
        local from, to = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
        if enabled["duplicate-frame"] and to > from then
          local dups = {}
          for f = from + 1, to do
            if composite(f):isEqual(composite(f - 1)) then dups[#dups + 1] = f end
          end
          if #dups > 0 then
            add{ rule = "duplicate-frame", severity = "warning", tag = tag.name, frames = dups,
                 fix = string.format("Frames %s repeat the frame before them in tag %s; draw the next pose, or remove the frame and lengthen the one before",
                   table.concat(dups, ","), tag.name) }
          end
        end
        if enabled["ground-jitter"] and to > from then
          local rows, lo, hi = {}, math.huge, -math.huge
          for f = from, to do
            local r = lowestRow(composite(f))
            if r then rows[#rows + 1] = { f = f, r = r }; lo = math.min(lo, r); hi = math.max(hi, r) end
          end
          if hi - lo >= 1 and hi - lo <= 3 then
            local off = {}
            for _, x in ipairs(rows) do if x.r ~= hi then off[#off + 1] = x.f end end
            add{ rule = "ground-jitter", severity = "warning", tag = tag.name, frames = off,
                 fix = string.format("The feet are %d px higher in frames %s of tag %s; keep the lowest pixel on row %d unless the character leaves the ground",
                   hi - lo, table.concat(off, ","), tag.name, hi) }
          end
        end
      end
    end

    -- Stated expectations run whatever `rules` selects: the caller asked for them by name.
    if expect then checkExpect(expect, sprite, frames, palette, add) end

    local errors, warnings = 0, 0
    for _, f in ipairs(findings) do
      if f.severity == "error" then errors = errors + 1 else warnings = warnings + 1 end
    end
    -- lightLayers: the names of the layers the pixel rules skipped (only when a pixel rule ran).
    return { findings = findings, errors = errors, warnings = warnings,
             checked = { layers = #layers, frames = #frames,
                         lightLayers = (pixelRules and #lightLayers > 0) and lightLayers or nil, rules = (function()
               local r = {}
               for _, name in ipairs(CHECK_RULES) do if enabled[name] then r[#r + 1] = name end end
               if expect and #expect.layerFrames > 0 then r[#r + 1] = "layer-frames" end
               if expect and #expect.overlaps > 0 then r[#r + 1] = "overlap" end
               return r
             end)() } }
  end

  handlers.check = check
end
