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
-- create_animation (#41): frames with durations and tags.
local a = H.call("create_animation", { width = 2, height = 1, title = "Anim", frames = {
  { rgba = "/wBN/wAAAAA=", duration = 120 }, { rgba = "AAAAAP8ATf8=", duration = 80 }, { rgba = "/wBN//8ATf8=" } },
  tags = { { name = "blink", from = 1, to = 2, direction = "pingpong" }, { name = "bad", from = 2, to = 9 } } })
local an = app.sprite
check("animation frames and durations", #an.frames == 3 and an.frames[1].duration == 0.12 and an.frames[3].duration == 0.1
  and app.pixelColor.rgbaA(an.layers[1]:cel(2).image:getPixel(0, 0)) == 0)
check("animation tags (out-of-range skipped)", #an.tags == 1 and an.tags[1].name == "blink" and an.tags[1].aniDir == AniDir.PING_PONG
  and a.title == "Anim")

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
