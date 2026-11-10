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

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
