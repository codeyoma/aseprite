-- Sprite area: writers of sprites and images for the skill tools: new
-- sprites, animations and tilemaps, images put into cels, layers split by
-- color, mirrored frames, slices, and text rendered by Aseprite.
-- Registers into the Document Handlers' table; see document_handlers.lua.
--
--   dofile("handlers_sprite.lua")(handlers, D)   -- D: shared helpers from document_handlers.lua

return function(handlers, D)
  local px, layerById, variations = D.px, D.layerById, D.variations
  local rgbaBytes = D.bytes
  local framesFromParam = D.framesFromParam
  -- The request's sprite (#90), which need not be the active one: its site, one undo step on it,
  -- running with it active (commands), and moving its frame and layer.
  local site, transaction, withActive = D.site, D.transaction, D.withActive

  -- An effect record for export (#71): params.fx = { layer?, id, x, y, fps, loop, windup_ms }, checked before
  -- anything changes. Returns the layer property value (aseprite-agent "fx", get_state's layer fx).
  local FX_KEY = "fx"
  local FX_TEXT_MAX = 16384
  local function checkFx(fx, withLayer)
    if type(fx) ~= "table" then error("fx: expected an object") end
    for k in pairs(fx) do
      if not (k == "id" or k == "x" or k == "y" or k == "fps" or k == "loop" or k == "windup_ms" or k == "recipe" or k == "render"
          or (withLayer and k == "layer")) then
        error("fx: unknown param '" .. tostring(k) .. "'")
      end
    end
    if withLayer and type(fx.layer) ~= "string" then error("fx: layer is required") end
    if type(fx.id) ~= "string" or fx.id == "" then error("fx: id is required") end
    if math.type(fx.x) ~= "integer" or math.type(fx.y) ~= "integer" then error("fx: x and y are whole pixels") end
    if type(fx.fps) ~= "number" or fx.fps <= 0 then error("fx: fps must be above 0") end
    if type(fx.loop) ~= "boolean" then error("fx: loop must be true or false") end
    if math.type(fx.windup_ms) ~= "integer" or fx.windup_ms < 0 then error("fx: windup_ms must be whole ms, 0 or more") end
    -- An FX recipe's JSON and the render settings (#72): text, kept small enough for a layer property.
    for _, k in ipairs({ "recipe", "render" }) do
      if fx[k] ~= nil and (type(fx[k]) ~= "string" or #fx[k] > FX_TEXT_MAX) then
        error("fx: " .. k .. " must be text of at most " .. FX_TEXT_MAX .. " characters")
      end
    end
    return { id = fx.id, x = fx.x, y = fx.y, fps = fx.fps, loop = fx.loop, windupMs = fx.windup_ms, recipe = fx.recipe, render = fx.render }
  end

  -- A new RGB sprite from RGBA bytes (a bytes param, #95), with an optional palette.
  handlers.create_sprite = function(params)
    local w, h = params.width, params.height
    local bytes = rgbaBytes(params.rgba or "")
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

  -- A new animated RGB sprite: frames of RGBA bytes (bytes params) with durations
  -- (ms) and tags (1-based frames), e.g. from import_sheet. params.fx (no
  -- layer) records an effect on its layer (new_fx_sprite, #71).
  handlers.create_animation = function(params)
    local w, h = params.width, params.height
    local frames = params.frames or {}
    if #frames == 0 then error("No frames") end
    local fx = params.fx ~= nil and checkFx(params.fx, false) or nil
    -- Everything is checked before the sprite is made, so an error leaves no sprite open.
    local images = {}
    for i, f in ipairs(frames) do
      local bytes = rgbaBytes(f.rgba or "")
      if #bytes ~= w * h * 4 then error(string.format("Frame %d: expected %d bytes, got %d", i, w * h * 4, #bytes)) end
      images[i] = bytes
    end
    for _, hx in ipairs(params.palette or {}) do px.parseHex(hx) end
    local sprite = Sprite(w, h, ColorMode.RGB)
    for i, f in ipairs(frames) do
      if i > 1 then sprite:newEmptyFrame() end
      local img = Image(w, h, ColorMode.RGB)
      img.bytes = images[i]
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
    if fx then sprite.layers[1].properties(variations.KEY)[FX_KEY] = fx end
    if params.title then sprite.filename = params.title end
    app.frame = sprite.frames[1]
    app.refresh()
    return { frames = #sprite.frames, tags = #sprite.tags, title = app.fs.fileTitle(sprite.filename) }
  end

  -- Splits a layer into one layer per color group (#40), across all frames,
  -- in one undo step: groups = { { name, colors = { "#rrggbb", ... } } }.
  -- Pixels in no group stay on the original layer (removed when empty).
  handlers.split_layer_by_colors = function(params)
    local sprite = site().sprite
    if sprite.colorMode ~= ColorMode.RGB then error("Splitting by color needs an RGB sprite") end
    local src = params.layer and layerById(params.layer, sprite) or site().layer
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
    transaction(sprite, "Split layer by color", function()
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

  -- A layer's blend mode and opacity from wire params (protocol.json blendModes), checked before anything changes.
  local function layerLook(params, what)
    local mode, opacity = nil, params.opacity
    if params.blend_mode ~= nil then
      mode = D.view.BLEND_MODES[params.blend_mode]
      if not mode then error(what .. "Unknown blend mode: " .. tostring(params.blend_mode)) end
    end
    if opacity ~= nil and (math.type(opacity) ~= "integer" or opacity < 0 or opacity > 255) then
      error(what .. "opacity must be an integer from 0 to 255")
    end
    if (mode or opacity) and not params.new_layer then
      error(what .. "blend_mode and opacity apply to a new layer (new_layer)")
    end
    return mode, opacity
  end

  -- An RGB image as an indexed one through the sprite's own palette: the exact
  -- entry (other than the transparent index), else the nearest by RGB; alpha 0
  -- is the transparent index. Image:drawImage maps through Aseprite's current
  -- palette instead, which misses entries added earlier in the same
  -- transaction (put_images' palette).
  local function toIndexed(img, sprite)
    local pal, pc = sprite.palettes[1], app.pixelColor
    local mask = sprite.transparentColor
    local entries = {}
    for i = 0, #pal - 1 do
      if i ~= mask then local c = pal:getColor(i); entries[#entries + 1] = { i = i, r = c.red, g = c.green, b = c.blue } end
    end
    local out = Image(img.width, img.height, ColorMode.INDEXED)
    out:clear(mask)
    local memo = {}
    for it in img:pixels() do
      local v = it()
      if pc.rgbaA(v) > 0 then
        local key = v & 0xffffff
        local idx = memo[key]
        if not idx then
          local r, g, b, best = pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), math.huge
          for _, e in ipairs(entries) do
            local d = (e.r - r) ^ 2 + (e.g - g) ^ 2 + (e.b - b) ^ 2
            if d < best then best, idx = d, e.i end
            if d == 0 then break end
          end
          idx = idx or mask
          memo[key] = idx
        end
        out:drawPixel(it.x, it.y, idx)
      end
    end
    return out
  end

  -- One image into a frame (inside the caller's transaction): params.layer
  -- (id or name) replaces that layer's cel, or params.new_layer = name puts
  -- it on an "AI: <name>" layer above params.above (created once, reused by
  -- later frames), with blend mode and opacity when given. Returns the layer.
  local function putOne(sprite, params, bytes, frame, mode, opacity)
    local w, h = params.width, params.height
    local target
    if params.new_layer then
      local name = variations.PREFIX .. params.new_layer
      local source = nil
      if params.above then
        source = layerById(params.above, sprite)
        if not source then error("Layer not found: " .. tostring(params.above)) end
      end
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
        local s = site()
        target = variations.aiLayer(params.new_layer, params.prompt, { above = source or s.layer, sprite = sprite })
        D.select(s, nil, target)
      end
      if params.hide_source and source then source.isVisible = false end
      -- hide: the new layer itself stays hidden (e.g. a normal map under the colors).
      if params.hide then target.isVisible = false end
      if mode then target.blendMode = mode end
      if opacity then target.opacity = opacity end
    else
      if params.layer then
        target = layerById(params.layer, sprite)
        if not target then error("No layer " .. tostring(params.layer)) end
      else
        target = site().layer
      end
      if not target or target.isGroup then error("No image layer to write to") end
    end
    local img = Image(w, h, ColorMode.RGB)
    img.bytes = bytes
    if sprite.colorMode == ColorMode.INDEXED then
      img = toIndexed(img, sprite)
    elseif sprite.colorMode ~= ColorMode.RGB then
      local conv = Image(w, h, sprite.colorMode)
      conv:drawImage(img)
      img = conv
    end
    sprite:newCel(target, frame, img, Point(params.x or 0, params.y or 0))
    return target
  end

  -- Writes RGBA pixels (a bytes param, canvas-sized at x, y) into a frame of a layer
  -- (#39): see putOne. hide_source hides the layer it was made from;
  -- blend_mode and opacity set up a new layer (#69). One undo step.
  handlers.put_image = function(params)
    local sprite = site().sprite
    local w, h = params.width, params.height
    local bytes = rgbaBytes(params.rgba or "")
    if #bytes ~= w * h * 4 then error(string.format("Expected %d bytes, got %d", w * h * 4, #bytes)) end
    local mode, opacity = layerLook(params, "")
    local frame = params.frame or site().frame
    local target
    transaction(sprite, params.label or "AI image", function()
      target = putOne(sprite, params, bytes, frame, mode, opacity)
    end)
    app.refresh()
    return { layer = "L" .. target.id, name = target.name }
  end

  -- Several images in one undo step (#69): params.images is a list of
  -- put_image params with a frame each. params.frames: the sprite first gets
  -- at least that many frames, each a copy of the last frame's cels (Aseprite's
  -- New Frame) lasting params.duration ms. Everything is checked before the
  -- sprite changes. params.palette: hex colors appended to the sprite palette
  -- first (the ones it lacks), in the same transaction. Returns the layers
  -- written, in order of first use, and paletteAdded when palette was given.
  --
  -- Timeline edits (#70), in the same transaction, before the images:
  -- params.insert = { { after, durations, shift? = { layers, offsets } } }
  -- puts #durations new frames right after frame `after` (numbered as before
  -- any insert). Each image layer's cel in a new frame is LINKED to its cel in
  -- `after` (LinkCels' CopyCel with links), except shift.layers, which get a
  -- copy moved by offsets[i] = { x, y } (linked cels share their position).
  -- Tags that cover `after` grow; later tags and recorded hits move. Then
  -- params.durations = { { frame, ms } } sets durations (final numbering) and
  -- params.hit = { frame, freeze_ms, shake_ms?, amp? } is appended to the
  -- sprite property aseprite-agent "fx.hits" (get_state's fxHits). Image
  -- frames use the final numbering. params.clear = { layer, ... } (#97) deletes
  -- every cel of those image layers first (an effect replaced on re-apply).
  local IMAGE_KEYS = { width = true, height = true, rgba = true, frame = true, new_layer = true, layer = true,
                       above = true, x = true, y = true, hide = true, hide_source = true, blend_mode = true, opacity = true, locked = true }
  local HITS_KEY = "fx.hits"
  -- A pixel spec (#79): JSON text in the sprite property aseprite-agent "concept.spec" (get_state's pixelSpec).
  local SPEC_KEY = "concept.spec"
  local SPEC_MAX = 65536
  -- The Motion Clip store (#109): JSON text in the sprite property aseprite-agent "motion" (get_state's motion).
  local MOTION_KEY = "motion"
  local function isInt(v) return math.type(v) == "integer" end

  -- params.insert checked, sorted by `after`, layers resolved. Returns the list and the frame count it adds.
  local function checkInserts(sprite, list)
    local out, seen, total = {}, {}, 0
    for i, ins in ipairs(list or {}) do
      local what = "Insert " .. i .. ": "
      if type(ins) ~= "table" then error(what .. "expected an object") end
      for k in pairs(ins) do
        if k ~= "after" and k ~= "durations" and k ~= "shift" then error(what .. "unknown param '" .. tostring(k) .. "'") end
      end
      if not isInt(ins.after) or ins.after < 1 or ins.after > #sprite.frames then
        error(string.format("%safter must be a frame from 1 to %d", what, #sprite.frames))
      end
      if seen[ins.after] then error(what .. "frame " .. ins.after .. " is listed twice") end
      seen[ins.after] = true
      local ds = ins.durations
      if type(ds) ~= "table" or #ds == 0 then error(what .. "durations must list at least one duration") end
      for _, d in ipairs(ds) do
        if not isInt(d) or d < 1 then error(what .. "durations must be whole ms of at least 1") end
      end
      local shift = {}
      if ins.shift ~= nil then
        local sh = ins.shift
        if type(sh) ~= "table" or type(sh.layers) ~= "table" or type(sh.offsets) ~= "table" then
          error(what .. "shift needs layers and offsets")
        end
        if #sh.offsets ~= #ds then error(what .. "shift needs one offset per new frame") end
        for _, o in ipairs(sh.offsets) do
          if type(o) ~= "table" or not isInt(o.x) or not isInt(o.y) then error(what .. "offsets are { x, y } in whole pixels") end
        end
        for _, ref in ipairs(sh.layers) do
          local l = layerById(ref, sprite)
          if not l or not l.isImage then error(what .. "no image layer " .. tostring(ref)) end
          shift[l.id] = true
        end
      end
      out[#out + 1] = { after = ins.after, durations = ds, shift = shift, offsets = ins.shift and ins.shift.offsets }
      total = total + #ds
    end
    table.sort(out, function(a, b) return a.after < b.after end)
    return out, total
  end

  -- The recorded hits (aseprite-agent "fx.hits") as plain tables.
  local function readHits(sprite)
    local out = {}
    for _, h in ipairs(sprite.properties(variations.KEY)[HITS_KEY] or {}) do
      out[#out + 1] = { frame = h.frame, freezeMs = h.freezeMs, shakeMs = h.shakeMs, amp = h.amp }
    end
    return out
  end

  -- One insert, inside the caller's transaction: new frames after `after`, cels linked (or moved copies).
  local function insertFrames(sprite, ins)
    local n = #ins.durations
    for k = 1, n do
      local nf = sprite:newEmptyFrame(ins.after + k)
      nf.duration = ins.durations[k] / 1000
    end
    local function each(layers)
      for _, l in ipairs(layers) do
        if l.isGroup then each(l.layers)
        elseif l.isImage then
          local cel = l:cel(ins.after)
          if cel and ins.shift[l.id] then
            for k = 1, n do
              local o = ins.offsets[k]
              sprite:newCel(l, ins.after + k, cel.image:clone(), Point(cel.position.x + o.x, cel.position.y + o.y))
            end
          elseif cel then
            local frames = {}
            for f = ins.after, ins.after + n do frames[#frames + 1] = sprite.frames[f] end
            app.range.layers = { l }
            app.range.frames = frames
            app.command.LinkCels()
          end
        end
      end
    end
    -- LinkCels is a command over app.range: it needs the sprite active (inside its transaction).
    withActive(sprite, function()
      each(sprite.layers)
      app.range:clear()
    end)
  end

  handlers.put_images = function(params)
    local sprite = site().sprite
    local images = params.images or {}
    local inserts, inserted = checkInserts(sprite, params.insert)
    if #images == 0 and #inserts == 0 and params.durations == nil and params.hit == nil and params.fx == nil and params.spec == nil and params.motion == nil
        and params.clear == nil then
      error("No images")
    end
    -- clear (#97): image layers whose cels are all deleted first, in the same undo step (an effect replaced on re-apply).
    local clearLayers = {}
    if params.clear ~= nil then
      if type(params.clear) ~= "table" then error("clear: expected a list of layers") end
      for _, ref in ipairs(params.clear) do
        local l = layerById(ref, sprite)
        if not l or not l.isImage then error("clear: no image layer " .. tostring(ref)) end
        clearLayers[#clearLayers + 1] = l
      end
    end
    if params.spec ~= nil and (type(params.spec) ~= "string" or #params.spec > SPEC_MAX) then
      error("spec must be text of at most " .. SPEC_MAX .. " characters")
    end
    if params.motion ~= nil and (type(params.motion) ~= "string" or #params.motion > SPEC_MAX) then
      error("motion must be text of at most " .. SPEC_MAX .. " characters")
    end
    local fx = params.fx ~= nil and checkFx(params.fx, true) or nil
    local count = math.max(#sprite.frames + inserted, params.frames or 0)
    if params.duration ~= nil and params.duration < 1 then error("duration must be at least 1 ms") end
    for i, d in ipairs(params.durations or {}) do
      if type(d) ~= "table" or not isInt(d.frame) or not isInt(d.ms) or d.ms < 1 then
        error("Durations " .. i .. ": expected { frame, ms } with ms of at least 1")
      end
      if d.frame < 1 or d.frame > count then error(string.format("Durations %d: frame %d is out of range (1-%d)", i, d.frame, count)) end
    end
    local hit = params.hit
    if hit ~= nil then
      if not isInt(hit.frame) or hit.frame < 1 or hit.frame > count then
        error(string.format("hit: frame must be from 1 to %d", count))
      end
      if not isInt(hit.freeze_ms) or hit.freeze_ms < 0 then error("hit: freeze_ms must be whole ms, 0 or more") end
      if hit.shake_ms ~= nil and (not isInt(hit.shake_ms) or hit.shake_ms < 0) then error("hit: shake_ms must be whole ms, 0 or more") end
      if hit.amp ~= nil and (not isInt(hit.amp) or hit.amp < 0) then error("hit: amp must be whole pixels, 0 or more") end
    end
    local checked = {}
    for i, im in ipairs(images) do
      local what = "Image " .. i .. ": "
      if type(im) ~= "table" then error(what .. "expected an object") end
      for k in pairs(im) do
        if not IMAGE_KEYS[k] then error(what .. "unknown param '" .. tostring(k) .. "'") end
      end
      if math.type(im.width) ~= "integer" or math.type(im.height) ~= "integer" or not D.wireParams.isBytes(im.rgba) then
        error(what .. "width, height and rgba are required")
      end
      if math.type(im.frame) ~= "integer" then error(what .. "frame is required") end
      if im.frame < 1 or im.frame > count then
        error(string.format("%sframe %d is out of range (1-%d)", what, im.frame, count))
      end
      local bytes = rgbaBytes(im.rgba)
      if #bytes ~= im.width * im.height * 4 then
        error(string.format("%sexpected %d bytes, got %d", what, im.width * im.height * 4, #bytes))
      end
      local mode, opacity = layerLook(im, what)
      if im.locked ~= nil and type(im.locked) ~= "boolean" then error(what .. "locked must be true or false") end
      if im.locked and not im.new_layer then error(what .. "locked applies to a new layer (new_layer)") end
      checked[i] = { bytes = bytes, mode = mode, opacity = opacity }
    end
    -- palette: colors to append (the ones the palette lacks, as normalized hex), checked first too.
    local paletteAdd = {}
    if params.palette ~= nil then
      local cur = sprite.palettes[1]
      local have = {}
      for i = 0, #cur - 1 do local c = cur:getColor(i); have[px.hex(c.red, c.green, c.blue, c.alpha)] = true end
      for _, h in ipairs(params.palette) do
        local key = px.hex(px.parseHex(h))
        if not have[key] then have[key] = true; paletteAdd[#paletteAdd + 1] = key end
      end
    end
    local layers, seen, added = {}, {}, 0
    local s = site()
    local activeFrame = s.frame
    local activeLayer = s.layer
    local locked = {}
    transaction(sprite, params.label or "AI images", function()
      for _, l in ipairs(clearLayers) do
        local cels = {}
        for _, c in ipairs(l.cels) do cels[#cels + 1] = c end
        for _, c in ipairs(cels) do sprite:deleteCel(c) end
      end
      -- The palette first, so an indexed sprite maps the new images onto the new entries.
      if #paletteAdd > 0 then
        local p = Palette(sprite.palettes[1])
        local start = #p
        p:resize(start + #paletteAdd)
        for i, h in ipairs(paletteAdd) do p:setColor(start + i - 1, Color(px.parseHex(h))) end
        sprite:setPalette(p)
      end
      -- Inserts, last first so every `after` keeps its number. Tag ranges and hits are worked out as numbers
      -- and set at the end: a tag covering `after` grows, a later one moves.
      if #inserts > 0 then
        local ranges = {}
        for i, t in ipairs(sprite.tags) do ranges[i] = { t.fromFrame.frameNumber, t.toFrame.frameNumber } end
        local hits = readHits(sprite)
        for k = #inserts, 1, -1 do
          local ins, n = inserts[k], #inserts[k].durations
          insertFrames(sprite, ins)
          for _, r in ipairs(ranges) do
            if r[1] > ins.after then r[1] = r[1] + n end
            if r[2] >= ins.after then r[2] = r[2] + n end
          end
          for _, h in ipairs(hits) do if h.frame > ins.after then h.frame = h.frame + n end end
          if activeFrame and activeFrame > ins.after then activeFrame = activeFrame + n end
        end
        for i, t in ipairs(sprite.tags) do
          if t.toFrame.frameNumber ~= ranges[i][2] then t.toFrame = ranges[i][2] end
          if t.fromFrame.frameNumber ~= ranges[i][1] then t.fromFrame = ranges[i][1] end
        end
        if #hits > 0 then sprite.properties(variations.KEY)[HITS_KEY] = hits end
      end
      -- New frames at the end, each a copy of the last frame's cels. Aseprite grows a tag that ends on the
      -- last frame over new frames; put them back (as mirror_frames does).
      local ends = {}
      for i, t in ipairs(sprite.tags) do ends[i] = t.toFrame.frameNumber end
      while #sprite.frames < count do
        local last = #sprite.frames
        local nf = sprite:newEmptyFrame(last + 1)
        nf.duration = params.duration and params.duration / 1000 or sprite.frames[last].duration
        local function copy(layers)
          for _, l in ipairs(layers) do
            if l.isGroup then copy(l.layers)
            elseif l.isImage then
              local cel = l:cel(last)
              if cel then sprite:newCel(l, nf.frameNumber, cel.image:clone(), cel.position) end
            end
          end
        end
        copy(sprite.layers)
        added = added + 1
      end
      for i, t in ipairs(sprite.tags) do
        if t.toFrame.frameNumber ~= ends[i] then t.toFrame = ends[i] end
      end
      for _, d in ipairs(params.durations or {}) do sprite.frames[d.frame].duration = d.ms / 1000 end
      if hit then
        local hits = readHits(sprite)
        hits[#hits + 1] = { frame = hit.frame, freezeMs = hit.freeze_ms, shakeMs = hit.shake_ms, amp = hit.amp }
        sprite.properties(variations.KEY)[HITS_KEY] = hits
      end
      for i, im in ipairs(images) do
        local c = checked[i]
        if params.prompt and im.new_layer then im.prompt = params.prompt end
        local target = putOne(sprite, im, c.bytes, im.frame, c.mode, c.opacity)
        local id = "L" .. target.id
        if im.locked then locked[#locked + 1] = target end
        if not seen[id] then
          seen[id] = true
          layers[#layers + 1] = { layer = id, name = target.name }
        end
      end
      -- The effect record (#71) on its layer: one written by this call (by name), else any layer by id or name.
      if fx then
        local target
        for _, l in ipairs(layers) do
          if l.name == params.fx.layer or l.layer == params.fx.layer then target = layerById(l.layer, sprite) end
        end
        target = target or layerById(params.fx.layer, sprite)
        if not target or target.isGroup then error("fx: no image layer " .. tostring(params.fx.layer)) end
        target.properties(variations.KEY)[FX_KEY] = fx
      end
      -- locked (#79): the layer is locked last, after every frame is written.
      for _, l in ipairs(locked) do l.isEditable = false end
      if params.spec ~= nil then sprite.properties(variations.KEY)[SPEC_KEY] = params.spec ~= "" and params.spec or nil end
      if params.motion ~= nil then sprite.properties(variations.KEY)[MOTION_KEY] = params.motion ~= "" and params.motion or nil end
    end)
    -- A locked layer never becomes the active one: the layer that was active stays (when there was one).
    D.select(s, activeFrame, (#locked > 0 and activeLayer and activeLayer.isEditable) and activeLayer or nil)
    app.refresh()
    return { layers = layers, frames = #sprite.frames, added = added, inserted = inserted,
             paletteAdded = params.palette ~= nil and #paletteAdd or nil }
  end

  -- Copies frames (a tag, or a list) to new frames at the end, flipped
  -- horizontally, as a new tag (#43): left from right, NW from NE. Layers in
  -- keep_layers are copied unflipped (a sword hand that must stay on its
  -- side is redrawn by hand instead). Existing tags keep their frames and
  -- the active frame stays. One undo step.
  handlers.mirror_frames = function(params)
    local sprite = site().sprite
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
    local activeFrame = site().frame
    transaction(sprite, "Mirror frames", function()
      -- Aseprite grows a tag that ends on the last frame over new frames; put them back.
      local ranges = {}
      for i, t in ipairs(sprite.tags) do ranges[i] = t.toFrame.frameNumber end
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
      for i, t in ipairs(sprite.tags) do
        if t.toFrame.frameNumber ~= ranges[i] then t.toFrame = ranges[i] end
      end
      if params.new_tag then
        local t = sprite:newTag(first, first + #frames - 1)
        t.name = params.new_tag
      end
    end)
    D.select(site(), activeFrame)
    app.refresh()
    return { from = first, to = first + #frames - 1, frames = #frames }
  end

  -- A slice with an optional 9-patch center (#50): engines stretch the
  -- center and keep the borders. Replaces a slice of the same name.
  handlers.set_slice = function(params)
    local sprite = site().sprite
    transaction(sprite, "Set slice", function()
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
    local bytes = rgbaBytes(params.rgba)
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
