-- create_sprite (#37): RGBA bytes from the bridge (base64) become a sprite.
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
-- 2x1: red, transparent. RGBA ff00004dff... base64 of bytes FF 00 4D FF 00 00 00 00 = "/wBN/wAAAAA="
local r = H.call("create_sprite", { width = 2, height = 1, rgba = "/wBN/wAAAAA=", title = "Fixed", palette = { "#ff004d" } })
local s = app.sprite
local px = s.cels[1].image:getPixel(0, 0)
check("sprite from bytes", s.width == 2 and app.pixelColor.rgbaR(px) == 255 and app.pixelColor.rgbaB(px) == 77
  and app.pixelColor.rgbaA(s.cels[1].image:getPixel(1, 0)) == 0)
check("palette and title", #s.palettes[1] == 1 and r.title == "Fixed")
check("size mismatch errors", not pcall(H.call, "create_sprite", { width = 3, height = 1, rgba = "/wBN/w==" }))
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
