-- Color area: color I/O for the palette and tone tools (#36, #38, #62).
-- The color science is in the bridge (color.ts); these read colors, apply
-- color maps, set the palette, draw swatches and save palette files.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_color.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua

return function(handlers, D)
  local px, layerById, variations = D.px, D.layerById, D.variations
  local framesFromParam, imageLayers, writePalette = D.framesFromParam, D.imageLayers, D.writePalette

  -- The image layers and frames a color request covers.
  local function colorTargets(sprite, params)
    local layers = {}
    if params.layer then
      local l = layerById(params.layer, sprite)
      if not l then error("Layer not found: " .. tostring(params.layer)) end
      if l.isGroup then imageLayers(l.layers, layers) else layers[1] = l end
    else
      imageLayers(sprite.layers, layers)
    end
    return layers, framesFromParam(sprite, params.frames)
  end

  -- Every distinct color in the target cels (or the selection), with counts.
  handlers.collect_colors = function(params)
    local sprite = app.sprite
    local layers, frames = colorTargets(sprite, params)
    local pc = app.pixelColor
    local palette = sprite.palettes[1]
    local sel = params.selection and not sprite.selection.isEmpty and sprite.selection or nil
    local counts, total, seenImages = {}, 0, {}
    for _, l in ipairs(layers) do
      if l.isVisible or params.hidden then
        for _, f in ipairs(frames) do
          local cel = l:cel(f)
          -- Linked cels share an image: count it once.
          if cel and not seenImages[cel.image.id] then
            seenImages[cel.image.id] = true
            local img, pos = cel.image, cel.position
            -- A tilemap's cel holds tile indexes: count the tiles' pixels.
            if l.isTilemap then img = px.toRgbImage(img, palette, l.tileset) end
            local mode = img.colorMode
            local mask = img.spec.transparentColor
            for it in img:pixels() do
              local x, y = it.x + pos.x, it.y + pos.y
              if not sel or sel:contains(x, y) then
                local v = it()
                local r, g, b, a
                if mode == ColorMode.RGB then
                  r, g, b, a = pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v)
                elseif mode == ColorMode.INDEXED then
                  if v ~= mask and v < #palette then
                    local c = palette:getColor(v); r, g, b, a = c.red, c.green, c.blue, c.alpha
                  else a = 0 end
                else
                  local gray = pc.grayaV(v); r, g, b, a = gray, gray, gray, pc.grayaA(v)
                end
                if a and a > 0 then
                  local key = px.hex(r, g, b, a)
                  counts[key] = (counts[key] or 0) + 1
                  total = total + 1
                end
              end
            end
          end
        end
      end
    end
    local colors = {}
    for k, n in pairs(counts) do colors[#colors + 1] = { hex = k, count = n } end
    table.sort(colors, function(a, b) return a.count > b.count end)
    return { colors = colors, pixels = total, colorMode = sprite.colorMode == ColorMode.INDEXED and "indexed" or
      (sprite.colorMode == ColorMode.GRAYSCALE and "grayscale" or "rgb") }
  end

  handlers.get_palette = function()
    local sprite = app.sprite
    local p, out = sprite.palettes[1], {}
    for i = 0, #p - 1 do
      local c = p:getColor(i)
      out[#out + 1] = px.hex(c.red, c.green, c.blue, c.alpha)
    end
    return { colors = out }
  end

  -- Replaces the sprite's palette (one undo step). In an indexed sprite the
  -- pixels keep their indexes, so their colors change with the palette.
  handlers.set_palette = function(params)
    local sprite = app.sprite
    local colors = params.colors or {}
    if #colors == 0 then error("No colors") end
    app.transaction(params.label or "Set palette", function()
      -- append: add the colors after the current palette's (skipping ones it
      -- has, compared as colors: "#0000FF" is "#0000ff").
      local start, list = 0, colors
      local p
      if params.append then
        local cur = sprite.palettes[1]
        local have, add = {}, {}
        for i = 0, #cur - 1 do local c = cur:getColor(i); have[px.hex(c.red, c.green, c.blue, c.alpha)] = true end
        for _, h in ipairs(colors) do
          local key = px.hex(px.parseHex(h))
          if not have[key] then have[key] = true; add[#add + 1] = h end
        end
        p = Palette(cur)
        start = #cur
        p:resize(#cur + #add)
        list = add
      else
        p = Palette(#colors)
      end
      for i, h in ipairs(list) do p:setColor(start + i - 1, Color(px.parseHex(h))) end
      sprite:setPalette(p)
    end)
    app.refresh()
    return { size = #colors }
  end

  -- Recolors the target cels with a { ["#from"] = "#to" } map (one undo step).
  -- Indexed sprites change palette entries instead of pixels.
  handlers.apply_color_map = function(params)
    local sprite = app.sprite
    local pc = app.pixelColor
    local map = {}
    for from, to in pairs(params.map or {}) do
      local r, g, b, a = px.parseHex(from)
      local r2, g2, b2, a2 = px.parseHex(to)
      map[pc.rgba(r, g, b, a)] = pc.rgba(r2, g2, b2, a2)
    end
    local changed = 0
    app.transaction(params.label or "Recolor", function()
      if sprite.colorMode == ColorMode.INDEXED then
        local p = sprite.palettes[1]
        for i = 0, #p - 1 do
          local c = p:getColor(i)
          local to = map[pc.rgba(c.red, c.green, c.blue, c.alpha)]
          if to then p:setColor(i, Color(pc.rgbaR(to), pc.rgbaG(to), pc.rgbaB(to), pc.rgbaA(to))); changed = changed + 1 end
        end
        return
      end
      if sprite.colorMode ~= ColorMode.RGB then error("Recoloring needs an RGB or indexed sprite") end
      local layers, frames = colorTargets(sprite, params)
      local seen = {}
      for _, l in ipairs(layers) do
        for _, f in ipairs(frames) do
          local cel = l:cel(f)
          if cel and not seen[cel.image.id] then
            seen[cel.image.id] = true
            local img = cel.image:clone()
            local n = 0
            for it in img:pixels() do
              local to = map[it()]
              if to then it(to); n = n + 1 end
            end
            if n > 0 then cel.image = img; changed = changed + n end
          end
        end
      end
    end)
    app.refresh()
    return { changed = changed, mode = sprite.colorMode == ColorMode.INDEXED and "palette entries" or "pixels" }
  end

  -- The image layer named name, anywhere in the layer tree.
  local function findImageLayer(layers, name)
    for _, l in ipairs(layers) do
      if l.isGroup then
        local f = findImageLayer(l.layers, name)
        if f then return f end
      elseif l.name == name then return l end
    end
  end

  -- A swatch strip of colors on the layer "AI: <name>" (one undo step): a new
  -- layer, or the existing one with that name, whose cel in the active frame
  -- is replaced. Either way it becomes the active layer.
  handlers.draw_swatches = function(params)
    local sprite = app.sprite
    local colors = params.colors or {}
    local size = params.size or math.max(1, math.min(8, sprite.width // math.max(1, #colors)))
    local layer
    app.transaction("Palette swatches", function()
      local name = params.name or "palette"
      layer = findImageLayer(sprite.layers, variations.PREFIX .. name)
      if layer then app.layer = layer
      else layer = variations.aiLayer(name, params.prompt) end
      local perRow = math.max(1, sprite.width // size)
      local img = Image(sprite.width, sprite.height, ColorMode.RGB)
      for i, h in ipairs(colors) do
        local x, y = ((i - 1) % perRow) * size, ((i - 1) // perRow) * size
        local r, g, b, a = px.parseHex(h)
        for dy = 0, size - 1 do for dx = 0, size - 1 do img:drawPixel(x + dx, y + dy, app.pixelColor.rgba(r, g, b, a)) end end
      end
      -- newCel replaces the layer's cel in that frame, if it has one.
      sprite:newCel(layer, app.frame or 1, img, Point(0, 0))
    end)
    app.refresh()
    return { layer = "L" .. layer.id }
  end

  -- Saves colors as a palette file in any format Aseprite writes (#62): .act,
  -- .col, .gpl, .hex, .pal, or an image such as .png or .aseprite.
  handlers.save_palette = function(params)
    local pal = Palette(#params.colors)
    for i, h in ipairs(params.colors) do pal:setColor(i - 1, px.color(h)) end
    -- The file is written by agent.lua: Aseprite asks permission per script file.
    writePalette(pal, params.path)
    if not app.fs.isFile(params.path) then error("Aseprite could not save a palette as " .. params.path) end
    return { path = params.path, colors = #params.colors }
  end
end
