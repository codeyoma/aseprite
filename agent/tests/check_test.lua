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

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
