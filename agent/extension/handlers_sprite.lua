-- Sprite area: writers of sprites and images for the skill tools: new
-- sprites, animations and tilemaps, images put into cels, layers split by
-- color, mirrored frames, slices, and text rendered by Aseprite.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_sprite.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua

return function(handlers, D)
  local px, layerById, variations = D.px, D.layerById, D.variations
  local framesFromParam = D.framesFromParam

  -- A new RGB sprite from RGBA bytes (base64), with an optional palette.
  handlers.create_sprite = function(params)
    local w, h = params.width, params.height
    local bytes = px.base64Decode(params.rgba or "")
    if #bytes ~= w * h * 4 then error(string.format("Expected %d bytes, got %d", w * h * 4, #bytes)) end
    local sprite = Sprite(w, h, ColorMode.RGB)
    local img = Image(w, h, ColorMode.RGB)
    img.bytes = bytes
    sprite.cels[1].image = img
    if params.palette and #params.palette > 0 then
      local p = Palette(#params.palette)
      for i, hx in ipairs(params.palette) do p:setColor(i - 1, Color(px.parseHex(hx))) end
      sprite:setPalette(p)
    end
    if params.title then sprite.filename = params.title end
    app.refresh()
    return { width = w, height = h, title = app.fs.fileTitle(sprite.filename) }
  end

  -- A new animated RGB sprite: frames of RGBA bytes (base64) with durations
  -- (ms) and tags (1-based frames), e.g. from import_sheet.
  handlers.create_animation = function(params)
    local w, h = params.width, params.height
    local frames = params.frames or {}
    if #frames == 0 then error("No frames") end
    local sprite = Sprite(w, h, ColorMode.RGB)
    for i, f in ipairs(frames) do
      if i > 1 then sprite:newEmptyFrame() end
      local bytes = px.base64Decode(f.rgba or "")
      if #bytes ~= w * h * 4 then error(string.format("Frame %d: expected %d bytes, got %d", i, w * h * 4, #bytes)) end
      local img = Image(w, h, ColorMode.RGB)
      img.bytes = bytes
      sprite:newCel(sprite.layers[1], i, img, Point(0, 0))
      sprite.frames[i].duration = (f.duration or 100) / 1000
    end
    if params.palette and #params.palette > 0 then
      local p = Palette(#params.palette)
      for i, hx in ipairs(params.palette) do p:setColor(i - 1, Color(px.parseHex(hx))) end
      sprite:setPalette(p)
    end
    local dirs = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG,
                   ["ping-pong"] = AniDir.PING_PONG }
    for _, t in ipairs(params.tags or {}) do
      if t.from >= 1 and t.to <= #sprite.frames and t.from <= t.to then
        local tag = sprite:newTag(t.from, t.to)
        tag.name = t.name
        if t.direction and dirs[t.direction] then tag.aniDir = dirs[t.direction] end
      end
    end
    if params.title then sprite.filename = params.title end
    app.frame = sprite.frames[1]
    app.refresh()
    return { frames = #sprite.frames, tags = #sprite.tags, title = app.fs.fileTitle(sprite.filename) }
  end

  -- Splits a layer into one layer per color group (#40), across all frames,
  -- in one undo step: groups = { { name, colors = { "#rrggbb", ... } } }.
  -- Pixels in no group stay on the original layer (removed when empty).
  handlers.split_layer_by_colors = function(params)
    local sprite = app.sprite
    if sprite.colorMode ~= ColorMode.RGB then error("Splitting by color needs an RGB sprite") end
    local src = params.layer and layerById(params.layer, sprite) or app.layer
    if not src or src.isGroup then error("Pick an image layer") end
    local pc = app.pixelColor
    local groupOf = {}
    for gi, g in ipairs(params.groups or {}) do
      for _, h in ipairs(g.colors or {}) do
        local r, gg, b = px.parseHex(h)
        groupOf[pc.rgba(r, gg, b, 255)] = gi
      end
    end
    local names, made = {}, {}
    app.transaction("Split layer by color", function()
      -- Each new layer goes just above the source, so the first group (the
      -- outline) ends up on top.
      for gi = 1, #params.groups do
        local l = sprite:newLayer()
        l.name = params.groups[gi].name
        l.parent = src.parent
        l.stackIndex = src.stackIndex + 1
        made[gi] = l
      end
      local leftover = false
      local cels = {}
      for _, c in ipairs(src.cels) do cels[#cels + 1] = c end
      for _, cel in ipairs(cels) do
        local img, pos = cel.image, cel.position
        local parts, rest = {}, img:clone()
        for it in img:pixels() do
          local v = it()
          local gi = pc.rgbaA(v) > 0 and groupOf[pc.rgba(pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), 255)]
          if gi then
            parts[gi] = parts[gi] or Image(img.width, img.height, ColorMode.RGB)
            parts[gi]:drawPixel(it.x, it.y, v)
            rest:drawPixel(it.x, it.y, 0)
          end
        end
        for gi, part in pairs(parts) do sprite:newCel(made[gi], cel.frameNumber, part, pos) end
        if rest:isEmpty() then sprite:deleteCel(cel) else cel.image = rest; leftover = true end
      end
      if not leftover then sprite:deleteLayer(src) else src.name = src.name .. " (rest)" end
    end)
    for gi = 1, #params.groups do names[#names + 1] = made[gi].name end
    app.refresh()
    return { layers = names }
  end

  -- Writes RGBA pixels (base64, canvas-sized at x, y) into a frame of a layer
  -- (#39): params.layer (id or name) replaces that layer's cel, or
  -- params.new_layer = name puts them on an "AI: <name>" layer above
  -- params.above (created once, reused by later frames). hide_source hides
  -- the layer it was made from. One undo step.
  handlers.put_image = function(params)
    local sprite = app.sprite
    local w, h = params.width, params.height
    local bytes = px.base64Decode(params.rgba or "")
    if #bytes ~= w * h * 4 then error(string.format("Expected %d bytes, got %d", w * h * 4, #bytes)) end
    local frame = params.frame or (app.frame and app.frame.frameNumber) or 1
    local target
    app.transaction(params.label or "AI image", function()
      if params.new_layer then
        local name = variations.PREFIX .. params.new_layer
        local source = params.above and layerById(params.above, sprite) or nil
        -- Reuse the layer made for an earlier frame. aiLayer puts it next to
        -- the source, inside the source's group when there is one.
        local function find(layers)
          for _, l in ipairs(layers) do
            if l.name == name and not l.isGroup then return l end
            if l.isGroup then local f = find(l.layers) if f then return f end end
          end
        end
        target = find(source and source.parent and source.parent.layers or sprite.layers) or find(sprite.layers)
        if not target then
          target = variations.aiLayer(params.new_layer, params.prompt, { above = source })
        end
        if params.hide_source and source then source.isVisible = false end
        -- hide: the new layer itself stays hidden (e.g. a normal map under the colors).
        if params.hide then target.isVisible = false end
      else
        if params.layer then
          target = layerById(params.layer, sprite)
          if not target then error("No layer " .. tostring(params.layer)) end
        else
          target = app.layer
        end
        if not target or target.isGroup then error("No image layer to write to") end
      end
      local img = Image(w, h, ColorMode.RGB)
      img.bytes = bytes
      if sprite.colorMode ~= ColorMode.RGB then
        local conv = Image(w, h, sprite.colorMode)
        conv:drawImage(img)
        img = conv
      end
      sprite:newCel(target, frame, img, Point(params.x or 0, params.y or 0))
    end)
    app.refresh()
    return { layer = "L" .. target.id, name = target.name }
  end

  -- Copies frames (a tag, or a list) to new frames at the end, flipped
  -- horizontally, as a new tag (#43): left from right, NW from NE. Layers in
  -- keep_layers are copied unflipped (a sword hand that must stay on its
  -- side is redrawn by hand instead). One undo step.
  handlers.mirror_frames = function(params)
    local sprite = app.sprite
    local frames = {}
    if params.tag then
      for _, t in ipairs(sprite.tags) do
        if t.name == params.tag then
          for f = t.fromFrame.frameNumber, t.toFrame.frameNumber do frames[#frames + 1] = f end
        end
      end
      if #frames == 0 then error("No tag named " .. tostring(params.tag)) end
    else
      frames = framesFromParam(sprite, params.frames)
    end
    local keep = {}
    for _, name in ipairs(params.keep_layers or {}) do
      local l = layerById(name, sprite)
      if l then keep[l.id] = true end   -- by id: layer objects are new wrappers on each access
    end
    local first
    app.transaction("Mirror frames", function()
      for i, f in ipairs(frames) do
        local nf = sprite:newEmptyFrame(#sprite.frames + 1)
        nf.duration = sprite.frames[f].duration
        if i == 1 then first = nf.frameNumber end
        local function copy(layers)
          for _, l in ipairs(layers) do
            if l.isGroup then copy(l.layers)
            elseif l.isImage then
              local cel = l:cel(f)
              if cel then
                local img = cel.image:clone()
                local pos = cel.position
                if not keep[l.id] then
                  img:flip(FlipType.HORIZONTAL)
                  pos = Point(sprite.width - (pos.x + img.width), pos.y)
                end
                sprite:newCel(l, nf.frameNumber, img, pos)
              end
            end
          end
        end
        copy(sprite.layers)
      end
      if params.new_tag then
        local t = sprite:newTag(first, first + #frames - 1)
        t.name = params.new_tag
      end
    end)
    app.refresh()
    return { from = first, to = first + #frames - 1, frames = #frames }
  end

  -- A slice with an optional 9-patch center (#50): engines stretch the
  -- center and keep the borders. Replaces a slice of the same name.
  handlers.set_slice = function(params)
    local sprite = app.sprite
    app.transaction("Set slice", function()
      for _, sl in ipairs(sprite.slices) do
        if sl.name == params.name then sprite:deleteSlice(sl) break end
      end
      local slice = sprite:newSlice(Rectangle(params.x or 0, params.y or 0, params.w or sprite.width, params.h or sprite.height))
      slice.name = params.name or "slice"
      if params.center then
        local c = params.center
        slice.center = Rectangle(c.x, c.y, c.w, c.h)
      end
    end)
    app.refresh()
    return { slices = #sprite.slices }
  end

  -- A new sprite with a tilemap layer (#59): the tiles (a set image cut into
  -- `count` tiles of `tile` px, `columns` per row) become its tileset, and
  -- `map` (rows of 0-based tile indices, -1 = empty) its cels. One sprite.
  handlers.create_tilemap = function(params)
    if not ColorMode.TILEMAP then error("Tilemap layers need Aseprite 1.3 or later") end
    local t, cols, count, map = params.tile, params.columns, params.count, params.map
    local rows, mapW = #map, #map[1]
    local set = Image(params.width, params.height, ColorMode.RGB)
    local bytes = px.base64Decode(params.rgba)
    if #bytes ~= params.width * params.height * 4 then error("Expected " .. params.width * params.height * 4 .. " bytes, got " .. #bytes) end
    set.bytes = bytes
    local sprite = Sprite(mapW * t, rows * t, ColorMode.RGB)
    sprite.gridBounds = Rectangle(0, 0, t, t)
    app.command.NewLayer{ tilemap = true }
    local layer = app.layer
    layer.name = params.title or "Terrain"
    local tileset = layer.tileset
    tileset.name = params.title or "Terrain"
    -- Tileset index 0 is the empty tile; set tile i is index i + 1.
    for i = 0, count - 1 do
      local img = Image(t, t, ColorMode.RGB)
      img:drawImage(set, Point(-(i % cols) * t, -(i // cols) * t))
      sprite:newTile(tileset).image = img
    end
    local cells = Image(mapW, rows, ColorMode.TILEMAP)
    for y = 1, rows do
      for x = 1, mapW do
        local i = map[y][x]
        if i >= 0 then cells:drawPixel(x - 1, y - 1, app.pixelColor.tile(i + 1, 0)) end
      end
    end
    sprite:newCel(layer, 1, cells, Point(0, 0))
    sprite:deleteLayer(sprite.layers[1])
    if params.title then sprite.filename = params.title end
    app.refresh()
    return { title = params.title or "Terrain", tiles = count, layer = "L" .. layer.id }
  end

  -- Text in a font file (TTF/OTF) or a system font, rendered by Aseprite
  -- without anti-aliasing (#61): white on transparent, trimmed. font is a
  -- PasteText font spec ("file=/path/font.ttf", "system=Arial"). The active
  -- sprite, frame and layer are kept.
  handlers.render_text = function(params)
    local prev, prevFrame, prevLayer = app.sprite, app.frame, app.layer
    local size = params.size or 8
    local lines = select(2, params.text:gsub("\n", "")) + 1
    local w = math.max(16, math.floor(#params.text * size * 1.5) + 16)
    local h = (math.floor(size * 2.5) + 8) * lines
    local tmp = Sprite(w, h, ColorMode.RGB)
    local ok, err = pcall(function()
      app.command.PasteText{ ui = false, text = params.text, fontName = params.font, fontSize = size,
        color = Color(255, 255, 255), x = 0, y = 0 }
    end)
    local img = Image(w, h, ColorMode.RGB)
    img:drawSprite(tmp, 1)
    tmp:close()
    if prev then
      app.sprite = prev
      if prevFrame then app.frame = prevFrame end
      if prevLayer then app.layer = prevLayer end
    end
    if not ok then error(err) end
    local b = img:shrinkBounds()
    if b.isEmpty then error("The font drew nothing: check the font file or name") end
    local out = Image(img, b)
    return { width = out.width, height = out.height }, out.bytes
  end
end
