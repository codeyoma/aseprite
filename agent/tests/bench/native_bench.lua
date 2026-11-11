-- Benchmark for #95: put_images transport and check's pixel rules, in a
-- headless Aseprite, through the Document Handlers (no WebSocket, no GUI).
--
--   node agent/tests/bench/native_bench.mjs        (runs this script; ASEPRITE picks the build)
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/bench/native_bench.lua
--
-- Fixture: one RGB layer, 12 frames of 256x256 palette art (16 colors in
-- 4x4 blocks, so most pixels have same-colored neighbors), with a few
-- off-palette and orphan pixels per frame. Prints the median of several runs
-- for: the pure-Lua base64 decode of the 12 images, put_images with base64
-- rgba, put_images with binary rgba ({ offset, length } into one blob, #95),
-- check over 12 frames and over one frame, and whether the native helpers
-- (Image:histogram, Image:isolatedPixels) are present.

local extDir = app.params.ext
local runs = tonumber(app.params.runs or "5")
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local px = dofile(app.fs.joinPath(extDir, "pixels.lua"))

local W, N = 256, 12
local sprite = Sprite(W, W, ColorMode.RGB)
for _ = 2, N do sprite:newEmptyFrame() end
local pal = Palette(17)
pal:setColor(0, Color(0, 0, 0, 0))
local colors = {}
for i = 1, 16 do
  local c = Color{ r = (i * 53) % 256, g = (i * 97) % 256, b = (i * 151) % 256, a = 255 }
  pal:setColor(i, c)
  colors[i] = c.rgbaPixel
end
sprite:setPalette(pal)

-- Frame images as raw bytes and base64.
local raw, b64 = {}, {}
local pc = app.pixelColor
for f = 1, N do
  local img = Image(W, W, ColorMode.RGB)
  for y = 0, W - 1 do
    for x = 0, W - 1 do
      local i = ((x // 4) * 7 + (y // 4) * 3 + f) % 16 + 1
      img:drawPixel(x, y, colors[i])
    end
  end
  for k = 0, 39 do   -- off-palette and lonely pixels
    img:drawPixel((k * 37 + f) % W, (k * 59 + f * 3) % W, pc.rgba(1 + k, 2, 3, 255))
  end
  raw[f] = img.bytes
  b64[f] = px.base64Encode(raw[f])
end

local function median(fn)
  local t = {}
  for i = 1, runs do
    local c = os.clock()
    fn()
    t[i] = (os.clock() - c) * 1000
  end
  table.sort(t)
  return t[(runs + 1) // 2]
end

local layerId = "L" .. sprite.layers[1].id
local function images(binary)
  local out, offset = {}, 0
  for f = 1, N do
    local rgba = b64[f]
    if binary then rgba = { offset = offset, length = #raw[f] }; offset = offset + #raw[f] end
    out[f] = { width = W, height = W, rgba = rgba, frame = f, layer = layerId }
  end
  return out
end
local blob = table.concat(raw)

local results = {}
results.decode = median(function() for f = 1, N do px.base64Decode(b64[f]) end end)
results.put_base64 = median(function() H.call("put_images", { images = images(false), label = "bench" }) end)
local okBin, errBin = pcall(H.call, "put_images", { images = images(true), label = "bench" }, blob)
if okBin then
  results.put_binary = median(function() H.call("put_images", { images = images(true), label = "bench" }, blob) end)
end
-- The written pixels are the fixture's.
local same = true
for f = 1, N do if sprite.layers[1]:cel(f).image.bytes ~= raw[f] then same = false end end

local findings, luaFindings
results.check12 = median(function() findings = H.call("check", { frames = "all" }) end)
results.check1 = median(function() H.call("check", { frames = 1 }) end)
-- The Lua walk (stock Aseprite's path), and whether both give the same findings.
H.setNativeCheck(false)
results.check12lua = median(function() luaFindings = H.call("check", { frames = "all" }) end)
results.check1lua = median(function() H.call("check", { frames = 1 }) end)
H.setNativeCheck(nil)
local sameFindings = json.encode(findings) == json.encode(luaFindings)
local counts = {}
for _, fd in ipairs(findings.findings or {}) do counts[fd.rule] = (counts[fd.rule] or 0) + 1 end

local probe = Image(1, 1, ColorMode.RGB)
print(string.format("BENCH runs=%d frames=%d size=%dx%d", runs, N, W, W))
print(string.format("BENCH base64Decode x%d      %8.2f ms", N, results.decode))
print(string.format("BENCH put_images base64      %8.2f ms", results.put_base64))
print(okBin and string.format("BENCH put_images binary      %8.2f ms", results.put_binary)
  or ("BENCH put_images binary      n/a (" .. tostring(errBin):sub(1, 80) .. ")"))
print(string.format("BENCH check 12 frames        %8.2f ms (Lua walk %8.2f ms)", results.check12, results.check12lua))
print(string.format("BENCH check 1 frame          %8.2f ms (Lua walk %8.2f ms)", results.check1, results.check1lua))
print("BENCH findings native == Lua " .. tostring(sameFindings))
print("BENCH pixels written match   " .. tostring(same))
print(string.format("BENCH findings off-palette=%d orphan=%d", counts["off-palette"] or 0, counts["orphan"] or 0))
local function has(name) local ok, v = pcall(function() return probe[name] end); return ok and v ~= nil end
print("BENCH native histogram       " .. tostring(has("histogram")))
print("BENCH native isolatedPixels  " .. tostring(has("isolatedPixels")))
