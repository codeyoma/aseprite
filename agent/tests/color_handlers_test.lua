-- Color I/O handlers (#36, #38): collect_colors, get/set_palette,
-- apply_color_map, draw_swatches. Batch mode.
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
local function count(colors, hex) for _, c in ipairs(colors) do if c.hex == hex then return c.count end end return 0 end

-- RGB: 2 frames, frame 2 linked to frame 1; a second layer.
local s = Sprite(4, 4, ColorMode.RGB)
s:newFrame()
local img = Image(4, 4, ColorMode.RGB)
img:drawPixel(0, 0, Color(255, 0, 77)); img:drawPixel(1, 0, Color(255, 0, 77)); img:drawPixel(2, 0, Color(41, 173, 255))
s.layers[1]:cel(1).image = img
app.range.layers = { s.layers[1] }; app.range.frames = { s.frames[1], s.frames[2] }; app.command.LinkCels(); app.range:clear()
local top = s:newLayer(); top.name = "Top"
local img2 = Image(4, 4, ColorMode.RGB); img2:drawPixel(3, 3, Color(0, 0, 0))
s:newCel(top, 1, img2, Point(0, 0))

local r = H.call("collect_colors", {})
check("collect counts linked cels once", count(r.colors, "#ff004d") == 2 and count(r.colors, "#29adff") == 1
  and count(r.colors, "#000000") == 1 and r.pixels == 4, json.encode(r))
r = H.call("collect_colors", { layer = "Top" })
check("collect one layer", #r.colors == 1 and r.colors[1].hex == "#000000")
s.selection = Selection(Rectangle(0, 0, 1, 1))
r = H.call("collect_colors", { selection = true })
check("collect the selection", #r.colors == 1 and r.colors[1].hex == "#ff004d" and r.colors[1].count == 1)
s.selection:deselect()

r = H.call("apply_color_map", { map = { ["#ff004d"] = "#00e436" } })
local px = s.layers[1]:cel(1).image:getPixel(0, 0)
check("apply_color_map recolors", r.changed == 2 and app.pixelColor.rgbaG(px) == 228
  and s.layers[1]:cel(2).image:getPixel(1, 0) == px, json.encode(r))
app.undo()
check("one undo step", app.pixelColor.rgbaR(s.layers[1]:cel(1).image:getPixel(0, 0)) == 255)

H.call("set_palette", { colors = { "#000000", "#ff004d", "#29adff" } })
r = H.call("get_palette", {})
check("set and get palette", #r.colors == 3 and r.colors[2] == "#ff004d")

r = H.call("draw_swatches", { colors = { "#000000", "#ff004d" }, name = "palette" })
check("swatches on an AI layer", s.layers[#s.layers].name == "AI: palette")

-- Indexed: the palette entries change, not the pixels.
local ix = Sprite(2, 2, ColorMode.INDEXED)
local pal = Palette(3); pal:setColor(0, Color(0, 0, 0, 0)); pal:setColor(1, Color(255, 0, 77)); pal:setColor(2, Color(41, 173, 255))
ix:setPalette(pal)
local ii = Image(2, 2, ColorMode.INDEXED); ii:drawPixel(0, 0, 1); ii:drawPixel(1, 0, 2); ii:drawPixel(0, 1, 2)
ix.layers[1]:cel(1).image = ii
r = H.call("collect_colors", {})
check("collect indexed", count(r.colors, "#29adff") == 2 and count(r.colors, "#ff004d") == 1 and r.colorMode == "indexed", json.encode(r))
r = H.call("apply_color_map", { map = { ["#29adff"] = "#1d2b53" } })
local c = ix.palettes[1]:getColor(2)
check("indexed maps palette entries", r.mode == "palette entries" and c.red == 29 and c.blue == 83)

-- split_layer_by_colors (#40): one layer per group, all frames, one undo step.
local sp = Sprite(4, 2, ColorMode.RGB)
sp:newFrame()
for f = 1, 2 do
  local im = Image(4, 2, ColorMode.RGB)
  im:drawPixel(0, 0, Color(24, 20, 37)); im:drawPixel(1, 0, Color(60, 170, 80)); im:drawPixel(2, 0, Color(255, 204, 170))
  im:drawPixel(3, f - 1, Color(9, 9, 9))
  sp.layers[1]:cel(f).image = im
end
app.layer = sp.layers[1]
r = H.call("split_layer_by_colors", { groups = {
  { name = "Outline", colors = { "#181425" } }, { name = "Green", colors = { "#3caa50" } }, { name = "Skin", colors = { "#ffccaa" } } } })
local names = {}
for _, l in ipairs(sp.layers) do names[#names + 1] = l.name end
check("split makes a layer per group, keeps the rest", table.concat(names, ",") == "Layer 1 (rest),Skin,Green,Outline"
  and #r.layers == 3, table.concat(names, ","))
local outline = sp.layers[4]
check("split covers every frame", outline:cel(1) and outline:cel(2)
  and app.pixelColor.rgbaR(outline:cel(2).image:getPixel(0 - outline:cel(2).position.x, 0 - outline:cel(2).position.y)) == 24)
app.undo()
check("split is one undo step", #sp.layers == 1 and sp.layers[1].name == "Layer 1")

-- put_image (#39): onto a new AI layer reused across frames, source hidden.
local ps = Sprite(2, 1, ColorMode.RGB)
ps:newFrame()
ps.layers[1].name = "Body"
app.layer = ps.layers[1]
H.call("put_image", { new_layer = "shaded Body", above = "Body", hide_source = true, frame = 1, width = 2, height = 1, rgba = "/wBN/wAAAAA=" })
H.call("put_image", { new_layer = "shaded Body", above = "Body", hide_source = true, frame = 2, width = 2, height = 1, rgba = "AAAAAP8ATf8=" })
check("put_image: one AI layer for both frames", #ps.layers == 2 and ps.layers[2].name == "AI: shaded Body"
  and ps.layers[2]:cel(1) and ps.layers[2]:cel(2) and not ps.layers[1].isVisible)
H.call("put_image", { layer = "Body", frame = 1, width = 2, height = 1, rgba = "AAAAAP8ATf8=" })
check("put_image: into an existing layer", app.pixelColor.rgbaA(ps.layers[1]:cel(1).image:getPixel(0, 0)) == 0
  or ps.layers[1]:cel(1).position.x == 1)

-- set_palette append (#39): only new colors are added.
H.call("set_palette", { colors = { "#000000", "#ff004d" } })
H.call("set_palette", { colors = { "#ff004d", "#29adff" }, append = true })
local pp = H.call("get_palette", {}).colors
check("palette append", #pp == 3 and pp[3] == "#29adff", table.concat(pp, ","))

-- mirror_frames (#43): a tag copied flipped as a new tag; kept layers unflipped.
local ms = Sprite(8, 4, ColorMode.RGB)
ms:newFrame()
local body = ms.layers[1]; body.name = "Body"
local sword = ms:newLayer(); sword.name = "Sword"
for f = 1, 2 do
  local b = Image(2, 2, ColorMode.RGB); b:clear(Color(255, 0, 0)); b:drawPixel(0, 0, Color(0, 0, 255))
  ms:newCel(body, f, b, Point(1, 1))
  local w = Image(1, 1, ColorMode.RGB); w:clear(Color(0, 255, 0))
  ms:newCel(sword, f, w, Point(6, 0))
end
local tg = ms:newTag(1, 2); tg.name = "walk_E"
r = H.call("mirror_frames", { tag = "walk_E", new_tag = "walk_W", keep_layers = { "Sword" } })
local wt
for _, t in ipairs(ms.tags) do if t.name == "walk_W" then wt = t end end
check("mirror: new frames and tag", #ms.frames == 4 and wt and wt.fromFrame.frameNumber == 3 and wt.toFrame.frameNumber == 4, json.encode(r))
local mc = body:cel(3)
check("mirror: flipped and moved", mc.position.x == 5 and app.pixelColor.rgbaB(mc.image:getPixel(1, 0)) == 255)
check("mirror: kept layer unflipped", sword:cel(3).position.x == 6)

-- set_slice (#50): a 9-patch slice, replaced by name.
local us = Sprite(20, 12, ColorMode.RGB)
H.call("set_slice", { name = "button", x = 0, y = 0, w = 20, h = 12, center = { x = 2, y = 2, w = 16, h = 8 } })
H.call("set_slice", { name = "button", x = 0, y = 0, w = 20, h = 12, center = { x = 3, y = 3, w = 14, h = 6 } })
check("slice with 9-patch center, replaced by name", #us.slices == 1 and us.slices[1].center.x == 3 and us.slices[1].center.width == 14)

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
