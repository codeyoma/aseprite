-- Batch-mode test of the extension's pixel and color module (#56).
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/pixels_test.lua
local px = dofile(app.fs.joinPath(app.params.ext, "pixels.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

check("hex: opaque has 6 digits", px.hex(255, 0, 16) == "#ff0010")
check("hex: alpha adds 2 digits", px.hex(1, 2, 3, 128) == "#01020380")
check("colorHex", px.colorHex(Color(10, 20, 30, 255)) == "#0a141e")
local r, g, b, a = px.parseHex("#0a141e80")
check("parseHex with alpha", r == 10 and g == 20 and b == 30 and a == 128)
r, g, b, a = px.parseHex("ff0010")
check("parseHex without # and alpha", r == 255 and g == 0 and b == 16 and a == 255)
local ok, err = pcall(px.parseHex, "#abc")
check("parseHex rejects short hex", not ok and tostring(err):find("Invalid color", 1, true), err)
check("color", px.color("#00ff00").green == 255)
check("base64Decode", px.base64Decode("AAEC/w==") == string.char(0, 1, 2, 255))

local s = Sprite(4, 2, ColorMode.INDEXED)
s.palettes[1]:setColor(1, Color(200, 100, 50, 255))
local img = Image(4, 2, ColorMode.INDEXED)
img:drawPixel(1, 0, 1)
local cel = s:newCel(s.layers[1], 1, img, Point(1, 0))
local rgb = px.toRgbImage(img, s.palettes[1])
check("toRgbImage converts indexed", rgb.colorMode == ColorMode.RGB and app.pixelColor.rgbaR(rgb:getPixel(1, 0)) == 200)
local seen = {}
px.eachPixel(cel, s.palettes[1], function(x, y, r, g, b, a) if a > 0 then seen[#seen + 1] = x .. "," .. y .. ":" .. r end end)
check("eachPixel walks in sprite coordinates", table.concat(seen, " ") == "2,0:200", table.concat(seen, " "))

print(failures == 0 and "ALL PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " failures") end
