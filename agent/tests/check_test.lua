-- Pixel-art check rules (#29): each rule against a sprite that triggers it
-- and one that doesn't. Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/check_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function findings(result, rule)
  local out = {}
  for _, f in ipairs(result.findings) do if f.rule == rule then out[#out + 1] = f end end
  return out
end

-- A sprite whose palette is exactly black, white, red, and the color we draw with.
local function newSprite(w, h, colors)
  local s = Sprite(w, h)
  local pal = Palette(#colors)
  for i, c in ipairs(colors) do pal:setColor(i - 1, c) end
  s:setPalette(pal)
  return s
end
local red, white, black = Color(255, 0, 0), Color(255, 255, 255), Color(0, 0, 0)

local function paint(sprite, frame, pixels, layer)
  layer = layer or sprite.layers[1]
  local img = Image(sprite.width, sprite.height)
  for _, p in ipairs(pixels) do img:drawPixel(p[1], p[2], p[3]) end
  sprite:newCel(layer, frame, img, Point(0, 0))
end

-- off-palette
do
  local s = newSprite(8, 8, { black, white, red })
  paint(s, 1, { { 1, 1, Color(250, 10, 10) }, { 2, 1, Color(250, 10, 10) }, { 3, 3, red } })
  local f = findings(H.check{ rules = { "off-palette" } }, "off-palette")
  check("off-palette: found", #f == 1 and f[1].count == 2 and f[1].color == "#fa0a0a", #f)
  check("off-palette: coordinates", f[1] and f[1].pixels[1][1] == 1 and f[1].pixels[1][2] == 1)
  check("off-palette: fix names nearest entry", f[1] and f[1].fix:match("index 2 %(#ff0000%)") ~= nil, f[1] and f[1].fix)
  paint(s, 1, { { 3, 3, red } })
  check("off-palette: clean", #findings(H.check{ rules = { "off-palette" } }, "off-palette") == 0)
  s:close()
end

-- orphan pixels
do
  local s = newSprite(8, 8, { black, red })
  paint(s, 1, { { 0, 0, red }, { 5, 5, black }, { 6, 5, black } })
  local f = findings(H.check{ rules = { "orphan" } }, "orphan")
  check("orphan: found, warning", #f == 1 and f[1].count == 1 and f[1].severity == "warning" and f[1].pixels[1][1] == 0)
  paint(s, 1, { { 5, 5, black }, { 6, 5, black } })
  check("orphan: clean", #findings(H.check{ rules = { "orphan" } }, "orphan") == 0)
  s:close()
end

-- semi-transparent
do
  local s = newSprite(4, 4, { black })
  paint(s, 1, { { 1, 1, Color(0, 0, 0, 128) } })
  local f = findings(H.check{ rules = { "semi-transparent" } }, "semi-transparent")
  check("semi-transparent: found, error", #f == 1 and f[1].severity == "error" and f[1].count == 1)
  paint(s, 1, { { 1, 1, black } })
  check("semi-transparent: clean", #findings(H.check{ rules = { "semi-transparent" } }, "semi-transparent") == 0)
  s:close()
end

-- empty cels inside a tag
do
  local s = newSprite(4, 4, { black })
  s:newEmptyFrame(); s:newEmptyFrame()
  paint(s, 1, { { 0, 0, black } }); paint(s, 3, { { 0, 0, black } })
  local tag = s:newTag(1, 3); tag.name = "walk"
  local f = findings(H.check{ rules = { "empty-cel" } }, "empty-cel")
  check("empty-cel: frame 2 of walk", #f == 1 and f[1].tag == "walk" and f[1].frames[1] == 2)
  paint(s, 2, { { 0, 0, black } })
  check("empty-cel: clean", #findings(H.check{ rules = { "empty-cel" } }, "empty-cel") == 0)
  s:close()
end

-- frame-duration outliers within a tag
do
  local s = newSprite(4, 4, { black })
  for _ = 1, 3 do s:newEmptyFrame() end
  for _, fr in ipairs(s.frames) do fr.duration = 0.1 end
  s.frames[3].duration = 0.5
  s:newTag(1, 4).name = "idle"
  local f = findings(H.check{ rules = { "frame-duration" } }, "frame-duration")
  check("frame-duration: frame 3", #f == 1 and f[1].frames[1] == 3 and f[1].fix:match("100 ms") ~= nil, f[1] and f[1].fix)
  s.frames[3].duration = 0.1
  check("frame-duration: clean", #findings(H.check{ rules = { "frame-duration" } }, "frame-duration") == 0)
  s:close()
end

-- content outside the canvas
do
  local s = newSprite(8, 8, { black })
  local img = Image(4, 4); img:clear(black)
  s:newCel(s.layers[1], 1, img, Point(6, 6))
  local f = findings(H.check{ rules = { "outside-canvas" } }, "outside-canvas")
  check("outside-canvas: found", #f == 1 and f[1].bounds.x == 6)
  s.layers[1]:cel(1).position = Point(2, 2)
  check("outside-canvas: clean", #findings(H.check{ rules = { "outside-canvas" } }, "outside-canvas") == 0)
  s:close()
end

-- whole check, options and summary
do
  local s = newSprite(8, 8, { black, red })
  paint(s, 1, { { 1, 1, Color(0, 0, 255) } })
  local r = H.check{}
  check("summary counts", r.errors >= 1 and r.warnings >= 1 and r.checked.layers == 1, r.errors .. "/" .. r.warnings)
  check("layer by id", H.check{ layer = "L" .. s.layers[1].id }.checked.layers == 1)
  check("unknown layer errors", not pcall(H.check, { layer = "Nope" }))
  check("through call()", H.call("check", { rules = { "orphan" } }).checked.rules[1] == "orphan")
  check("json-encodable", pcall(json.encode, r))
  s:close()
end

-- Animation rules (#42).
do
  local a = Sprite(8, 8, ColorMode.RGB)
  for i = 1, 3 do a:newFrame() end
  local function body(f, y0)
    local img = Image(8, 8, ColorMode.RGB)
    for y = y0, y0 + 3 do img:drawPixel(3, y, Color(255, 0, 0)); img:drawPixel(4, y, Color(255, 0, 0)) end
    img:drawPixel(f % 2 == 0 and 2 or 5, y0, Color(255, 0, 0))
    a.layers[1]:cel(f).image = img
  end
  body(1, 4); body(2, 4); body(3, 3); body(4, 4)
  a.layers[1]:cel(2).image = a.layers[1]:cel(1).image:clone()   -- frame 2 repeats frame 1
  local t = a:newTag(1, 4) t.name = "walk"
  local r = H.call("check", { rules = { "duplicate-frame", "ground-jitter" } })
  local dup, jit
  for _, f in ipairs(r.findings) do
    if f.rule == "duplicate-frame" then dup = f end
    if f.rule == "ground-jitter" then jit = f end
  end
  check("duplicate frame found", dup and dup.frames[1] == 2, dup and json.encode(dup))
  check("ground jitter found", jit and jit.frames[1] == 3 and jit.fix:match("1 px higher"), jit and json.encode(jit))
end

-- Light layers (#69): a layer that doesn't blend Normal (an Addition glow) is skipped by the pixel rules.
do
  local s = newSprite(8, 8, { black, red })
  paint(s, 1, { { 1, 1, red }, { 2, 1, red } })
  local glow = s:newLayer()
  glow.name = "AI: fx hit-spark glow"
  glow.blendMode = BlendMode.ADDITION
  paint(s, 1, { { 5, 5, Color(250, 200, 10, 120) } }, glow)
  local r = H.call("check", { rules = { "off-palette", "orphan", "semi-transparent" } })
  local onGlow = 0
  for _, f in ipairs(r.findings) do if f.layer == glow.name then onGlow = onGlow + 1 end end
  check("light layer: no pixel findings", onGlow == 0, json.encode(r.findings))
  check("light layer: named as skipped", r.checked.lightLayers and #r.checked.lightLayers == 1
    and r.checked.lightLayers[1] == glow.name, json.encode(r.checked))
  glow.blendMode = BlendMode.NORMAL
  r = H.call("check", { rules = { "off-palette", "semi-transparent" } })
  check("normal layer: judged again", #findings(r, "off-palette") == 1 and #findings(r, "semi-transparent") == 1
    and r.checked.lightLayers == nil, json.encode(r))
  local plain = H.call("check", { rules = { "frame-duration" } })
  check("no pixel rules: nothing skipped", plain.checked.lightLayers == nil)
  s:close()
end

-- Stated expectations (#80): layer_frames and must_not_overlap, by name or id, groups and linked cels.
do
  local s = newSprite(8, 8, { black, red, white })
  for _ = 1, 3 do s:newEmptyFrame() end            -- 4 frames
  local body = s.layers[1]; body.name = "Body"
  local weapon = s:newLayer(); weapon.name = "Weapon"
  for f = 1, 4 do paint(s, f, { { 1, 6, black } }, body) end
  -- Weapon: art on 2-3 as stated, plus a stray on frame 4 (a cel linked from frame 3).
  paint(s, 2, { { 6, 1, red } }, weapon)
  paint(s, 3, { { 6, 2, red } }, weapon)
  s:newCel(weapon, 4)
  app.range:clear()
  local linked = weapon:cel(3)
  s:deleteCel(weapon, 4)
  -- Link frame 4 to frame 3 the way the timeline does.
  app.sprite = s
  app.range.layers = { weapon }
  app.range.frames = { s.frames[3], s.frames[4] }
  app.command.LinkCels()
  app.range:clear()
  check("expect: frame 4 is linked to 3", weapon:cel(4) and weapon:cel(4).image == linked.image)

  local r = H.call("check", { rules = { "orphan" }, expect = { layer_frames = { Weapon = "2-3" } } })
  local f = findings(r, "layer-frames")
  check("layer_frames: linked cel outside the range", #f == 1 and f[1].frames[1] == 4 and f[1].severity == "error"
    and f[1].layer == "Weapon" and f[1].fix:match("2%-3") ~= nil, json.encode(r.findings))
  check("layer_frames: runs whatever rules select", r.checked.rules[2] == "layer-frames", json.encode(r.checked.rules))

  r = H.call("check", { rules = {}, expect = { layer_frames = { ["L" .. weapon.id] = "2-4" } } })
  check("layer_frames: by id, linked cel counts as art", #findings(r, "layer-frames") == 0, json.encode(r.findings))

  r = H.call("check", { expect = { layer_frames = { Weapon = "1-3" } }, rules = { "orphan" } })
  f = findings(r, "layer-frames")
  local miss
  for _, x in ipairs(f) do if x.fix:match("no art") then miss = x end end
  check("layer_frames: missing cel inside the range", #f == 2 and miss and miss.frames[1] == 1 and #miss.frames == 1,
    json.encode(f))

  -- An empty cel counts as missing.
  s:newCel(weapon, 1, Image(8, 8), Point(0, 0))
  r = H.call("check", { rules = { "orphan" }, expect = { layer_frames = { Weapon = "1-4" } } })
  f = findings(r, "layer-frames")
  check("layer_frames: empty cel inside the range", #f == 1 and f[1].frames[1] == 1, json.encode(f))

  -- Only the checked frames are judged.
  r = H.call("check", { rules = { "orphan" }, frames = "1-3", expect = { layer_frames = { Weapon = "2-3" } } })
  check("layer_frames: limited to frames", #findings(r, "layer-frames") == 0, json.encode(r.findings))

  -- Groups: a group's art is its image layers' art.
  local group = s:newGroup(); group.name = "Arm"
  weapon.parent = group
  r = H.call("check", { rules = { "orphan" }, expect = { layer_frames = { Arm = "2-3" } } })
  f = findings(r, "layer-frames")
  check("layer_frames: group by name", #f == 1 and f[1].layer == "Arm" and f[1].frames[1] == 4, json.encode(f))
  weapon.parent = s

  -- must_not_overlap: the weapon crosses the head in frame 3 only.
  local head = s:newLayer(); head.name = "Head"
  for f2 = 1, 4 do paint(s, f2, { { 6, 2, white }, { 5, 2, white } }, head) end
  r = H.call("check", { rules = { "orphan" }, expect = { must_not_overlap = { { "Weapon", "Head" } } } })
  f = findings(r, "overlap")
  check("overlap: found on frames 3 and its linked frame 4", #f == 2 and f[1].frame == 3 and f[2].frame == 4,
    json.encode(f))
  check("overlap: count, coordinates, both layers, error with a fix", f[1] and f[1].count == 1 and f[1].pixels[1][1] == 6
    and f[1].pixels[1][2] == 2 and f[1].layer == "Weapon" and f[1].other == "Head" and f[1].otherId == "L" .. head.id
    and f[1].severity == "error" and f[1].fix:match("Weapon and Head") ~= nil, f[1] and json.encode(f[1]))
  check("overlap: json-encodable", pcall(json.encode, r))

  -- A faint pixel (alpha below 128) does not collide.
  paint(s, 2, { { 6, 1, Color(255, 255, 255, 60) } }, head)
  r = H.call("check", { rules = {}, frames = 2, expect = { must_not_overlap = { { "Weapon", "Head" } } } })
  check("overlap: faint pixels ignored", #findings(r, "overlap") == 0, json.encode(r.findings))

  -- Groups on either side; by id.
  local face = s:newGroup(); face.name = "Face"
  head.parent = face
  r = H.call("check", { rules = {}, expect = { must_not_overlap = { { "L" .. weapon.id, "Face" } } } })
  f = findings(r, "overlap")
  check("overlap: group and id", #f == 2 and f[1].other == "Face", json.encode(f))

  -- Clean: the weapon passes in front of the head, not through it.
  weapon:cel(3).position = Point(0, 4)
  r = H.call("check", { rules = {}, expect = { must_not_overlap = { { "Weapon", "Face" } } } })
  check("overlap: clean", #findings(r, "overlap") == 0, json.encode(r.findings))

  -- Malformed expectations fail before any work, naming the problem.
  local function fails(params, pattern)
    local ok, err = pcall(H.call, "check", params)
    return not ok and tostring(err):match(pattern) ~= nil, tostring(err)
  end
  check("expect: unknown layer", fails({ expect = { layer_frames = { Nope = "1-2" } } }, "Layer not found: Nope"))
  check("expect: unknown key", fails({ expect = { layers = {} } }, "unknown expectation 'layers'"))
  check("expect: bad range", fails({ expect = { layer_frames = { Weapon = "2-9" } } }, "out of range"))
  check("expect: pair of one", fails({ expect = { must_not_overlap = { { "Weapon" } } } }, "must be a pair"))
  check("expect: same layer twice", fails({ expect = { must_not_overlap = { { "Weapon", "Weapon" } } } }, "twice"))
  check("expect: not an object", fails({ expect = { 1, 2 } }, "'expect' must be a"))
  s:close()
end

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
