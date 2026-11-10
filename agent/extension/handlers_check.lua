-- Check area (#29): mechanical pixel-art checks, the `check` request.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_check.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua

return function(handlers, D)
  local px, layerById, layerId = D.px, D.layerById, D.view.layerId
  local framesFromParam, imageLayers = D.framesFromParam, D.imageLayers

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

  -- Runs the pixel-art checks and returns { findings, summary }.
  -- params: layer (id or name), frames ("1-4", n or list), rules (list of names).
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

  handlers.check = check
end
