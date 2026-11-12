-- #95: binary pixel transport (requests with a binary frame, rgba as
-- { offset, length }) and check's native pixel helpers (Image:histogram,
-- Image:isolatedPixels) against the Lua walk. Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script-param tmp=<dir> --script agent/tests/native_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local StepCapture = dofile(app.fs.joinPath(extDir, "step_capture.lua"))
local DocumentHandlers = dofile(app.fs.joinPath(extDir, "document_handlers.lua"))
local capture = StepCapture.new{ limit = 5, edits = DocumentHandlers.writes(P) }
local H = DocumentHandlers.new{ chunkDir = extDir, protocol = P, capture = capture }
local px = dofile(app.fs.joinPath(extDir, "pixels.lua"))
local pc = app.pixelColor

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function fails(fn, pattern)
  local ok, err = pcall(fn)
  return not ok and tostring(err):match(pattern) ~= nil, tostring(err)
end

-- Images as raw bytes.
local function art(w, h, seed)
  local img = Image(w, h, ColorMode.RGB)
  for y = 0, h - 1 do for x = 0, w - 1 do
    img:drawPixel(x, y, pc.rgba((x * 16 + seed) % 256, (y * 16) % 256, seed % 256, 255))
  end end
  return img.bytes
end

---------------------------------------------------------------------------
-- Binary put_images: the same pixels as base64, one undo step, step capture.
---------------------------------------------------------------------------
do
  local sprite = Sprite(8, 8, ColorMode.RGB)
  sprite:newEmptyFrame()
  local a, b = art(8, 8, 1), art(4, 4, 2)
  local blob = "XYZ" .. a .. b   -- refs need not start at 0
  local function images(binary)
    return {
      { width = 8, height = 8, frame = 1, new_layer = binary and "bin" or "b64", rgba = binary and { offset = 3, length = #a } or px.base64Encode(a) },
      { width = 4, height = 4, frame = 2, x = 2, y = 2, new_layer = binary and "bin" or "b64", rgba = binary and { offset = 3 + #a, length = #b } or px.base64Encode(b) },
    }
  end
  local undoBefore = sprite.undoHistory.undoSteps
  local seq = capture:seq()
  local r = H.call("put_images", { images = images(true), label = "binary" }, blob)
  check("binary put_images ok", r and r.layers and #r.layers == 1, r and json.encode(r))
  check("binary put_images is one undo step", sprite.undoHistory.undoSteps == undoBefore + 1, sprite.undoHistory.undoSteps - undoBefore)
  local step = capture:last()
  check("binary put_images captured", capture:seq() == seq + 1 and step and step.method == "put_images", step and step.method)
  H.call("put_images", { images = images(false), label = "base64" })
  local function layer(name) for _, l in ipairs(sprite.layers) do if l.name == name then return l end end end
  local bin, b64 = layer("AI: bin"), layer("AI: b64")
  check("binary layer made", bin ~= nil and b64 ~= nil)
  local same = bin and b64 and true
  for f = 1, 2 do
    local c1, c2 = bin and bin:cel(f), b64 and b64:cel(f)
    if not (c1 and c2 and c1.image.bytes == c2.image.bytes and c1.position == c2.position) then same = false end
  end
  check("binary and base64 write the same pixels", same)
  check("binary pixels are the given bytes", bin and bin:cel(1).image.bytes == a)

  -- Validation: the same errors, and nothing changes.
  local before = sprite.undoHistory.undoSteps
  local function put(rgba, blobArg, w)
    return function() H.call("put_images", { images = { { width = w or 8, height = 8, frame = 1, rgba = rgba } } }, blobArg) end
  end
  check("past the end of the frame", fails(put({ offset = #blob - 10, length = #a }, blob), "past the end of the binary frame"))
  check("no binary frame", fails(put({ offset = 0, length = #a }, nil), "did not carry"))
  check("wrong size", fails(put({ offset = 3, length = #b }, blob), "Image 1: expected 256 bytes, got 64"))
  check("bad ref", fails(put({ offset = -1, length = 4 }, blob), "width, height and rgba are required"))
  check("bad ref key", fails(put({ offset = 0, length = 4, x = 1 }, blob), "width, height and rgba are required"))
  check("put_image bytes type", fails(function() H.call("put_image", { width = 1, height = 1, rgba = 5 }) end, "'rgba' must be a bytes"))
  check("errors change nothing", sprite.undoHistory.undoSteps == before)

  -- put_image and create_sprite take a ref too; the blob is per call.
  local r2 = H.call("put_image", { width = 4, height = 4, rgba = { offset = 3 + #a, length = #b }, frame = 1, new_layer = "one" }, blob)
  check("binary put_image", r2 and r2.name == "AI: one" and layer("AI: one"):cel(1).image.bytes == b)
  check("blob is per call", fails(put({ offset = 3, length = #a }, nil), "did not carry"))
  sprite:close()
  local made = H.call("create_sprite", { width = 4, height = 4, rgba = { offset = 0, length = #b } }, b)
  check("binary create_sprite", made and app.sprite.cels[1].image.bytes == b)
  app.sprite:close()
end

---------------------------------------------------------------------------
-- The connection: a request with binary: <n> waits for its frame.
---------------------------------------------------------------------------
do
  local tmp = app.params.tmp or app.fs.tempPath
  local session = app.fs.joinPath(tmp, "native-session.json")
  local f = assert(io.open(session, "w")); f:write('{"port": 1, "token": "t"}'); f:close()
  local sent = {}
  local fakeSocket = {
    connect = function() end, close = function() end,
    sendText = function(_, text) sent[#sent + 1] = json.decode(text) end,
    sendBinary = function(_, bytes) sent[#sent + 1] = { binaryFrame = bytes } end,
  }
  local calls = {}
  local conn = dofile(app.fs.joinPath(extDir, "bridge_connection.lua")).new{
    protocol = P, sessionPath = session,
    onRequest = function(method, params, origin, chat, blob)
      calls[#calls + 1] = { method = method, blob = blob }
      return { ok = true }
    end,
    readFile = function(path) local h = io.open(path); local t = h:read("a"); h:close(); return t end,
    runShell = function() end,
    openSocket = function() return fakeSocket end,
  }
  conn.connect(true)
  local T = WebSocketMessageType
  conn.receive(T.TEXT, json.encode{ jsonrpc = "2.0", id = 1, method = "put_images", params = {}, binary = 5 })
  check("request waits for its frame", #calls == 0)
  conn.receive(T.BINARY, "hello")
  check("frame passed with the request", #calls == 1 and calls[1].blob == "hello", calls[1] and calls[1].blob)
  check("request answered", sent[#sent] and sent[#sent].id == 1 and sent[#sent].result ~= nil)
  conn.receive(T.TEXT, json.encode{ jsonrpc = "2.0", id = 2, method = "put_images", params = {}, binary = 9 })
  conn.receive(T.BINARY, "short")
  check("length mismatch is an error", #calls == 1 and sent[#sent].id == 2 and tostring(sent[#sent].error.message):match("has 5 bytes"))
  conn.receive(T.TEXT, json.encode{ jsonrpc = "2.0", id = 3, method = "put_images", params = {}, binary = 4 })
  conn.receive(T.TEXT, json.encode{ jsonrpc = "2.0", id = 4, method = "get_state", params = {} })
  local missing = false
  for _, m in ipairs(sent) do if m.id == 3 and m.error and tostring(m.error.message):match("did not arrive") then missing = true end end
  check("missing frame is an error", missing)
  check("next request still runs", #calls == 2 and calls[2].method == "get_state" and calls[2].blob == nil)
  conn.receive(T.BINARY, "late")
  check("stray frame ignored", #calls == 2)
  conn.disconnect()
  os.remove(session)
end

---------------------------------------------------------------------------
-- Native helpers, and check's findings with and without them.
---------------------------------------------------------------------------
local probe = Image(1, 1, ColorMode.RGB)
local native = pcall(function() return probe.histogram and probe.isolatedPixels end) and probe.histogram ~= nil
print("native helpers: " .. tostring(native))
if native then
  local img = Image(4, 3, ColorMode.RGB)
  local red, blue = pc.rgba(255, 0, 0, 255), pc.rgba(0, 0, 255, 255)
  img:drawPixel(0, 0, red); img:drawPixel(1, 0, red); img:drawPixel(3, 2, blue); img:drawPixel(3, 0, blue)
  local h = img:histogram()
  check("histogram counts", h[red] == 2 and h[blue] == 2 and h[0] == 8)
  local count, list = img:isolatedPixels()
  check("isolated pixels", count == 2 and #list == 2 and list[1][1] == 3 and list[1][2] == 0 and list[2][1] == 3 and list[2][2] == 2)
  local c1, l1 = img:isolatedPixels(1)
  check("isolated limit keeps the count", c1 == 2 and #l1 == 1)
  local ind = Image(3, 1, ColorMode.INDEXED)
  ind:drawPixel(0, 0, 2); ind:drawPixel(2, 0, 2)
  local ci = ind:isolatedPixels()
  check("indexed: mask skipped", ci == 2 and ind:histogram()[0] == 1)
end

-- Fixtures where the two paths could differ: cel offsets, alpha variants of
-- an off-palette color, many semi-transparent colors, an indexed sprite.
local function compare(name, sprite, params)
  H.setNativeCheck(false)
  local luaResult = H.call("check", params or {})
  H.setNativeCheck(nil)
  local nativeResult = H.call("check", params or {})
  check(name .. ": same findings", json.encode(luaResult) == json.encode(nativeResult),
    #json.encode(luaResult) .. " vs " .. #json.encode(nativeResult))
  return nativeResult
end
do
  local s = Sprite(40, 30, ColorMode.RGB)
  local pal = Palette(4)
  pal:setColor(0, Color(0, 0, 0, 0)); pal:setColor(1, Color(255, 0, 0)); pal:setColor(2, Color(0, 255, 0)); pal:setColor(3, Color(0, 0, 255))
  s:setPalette(pal)
  local img = Image(30, 20, ColorMode.RGB)
  for y = 0, 19 do for x = 0, 29 do
    if (x + y) % 3 == 0 then img:drawPixel(x, y, pc.rgba(255, 0, 0, 255))
    elseif x < 10 then img:drawPixel(x, y, pc.rgba(0, 255, 0, 255))
    elseif x < 20 then img:drawPixel(x, y, pc.rgba(x * 8, y * 8, 7, 40 + x + y))   -- many semi colors
    else img:drawPixel(x, y, pc.rgba(9, 9, 9, (x % 2 == 0) and 255 or 128)) end  -- one rgb, two alphas
  end end
  s:newCel(s.layers[1], 1, img, Point(-3, 12))   -- partly outside the canvas
  local r = compare("rgb", s)
  local rules = {}
  for _, fd in ipairs(r.findings) do rules[fd.rule] = (rules[fd.rule] or 0) + 1 end
  check("rgb fixture has findings", (rules["off-palette"] or 0) > 0 and (rules["semi-transparent"] or 0) > 0 and (rules["orphan"] or 0) > 0,
    json.encode(rules))
  compare("rgb, some rules", s, { rules = { "orphan", "semi-transparent" } })
  s:close()

  local si = Sprite(12, 8, ColorMode.INDEXED)
  local p2 = Palette(4)
  p2:setColor(0, Color(0, 0, 0, 0)); p2:setColor(1, Color(255, 0, 0)); p2:setColor(2, Color(255, 0, 0)); p2:setColor(3, Color(0, 0, 255, 100))
  si:setPalette(p2)
  local ii = Image(12, 8, ColorMode.INDEXED)
  for y = 0, 7 do for x = 0, 11 do ii:drawPixel(x, y, (x * 3 + y) % 4) end end
  si:newCel(si.layers[1], 1, ii, Point(0, 0))
  compare("indexed (duplicate palette colors)", si)
  si:close()
end

-- #114: Image:diff against the Lua walk (step capture's measure and diff image).
do
  local a, b = Image(9, 7, ColorMode.RGB), Image(9, 7, ColorMode.RGB)
  for y = 0, 6 do for x = 0, 8 do a:drawPixel(x, y, pc.rgba(x * 20, y * 30, 90, (x + y) % 3 == 0 and 0 or 255)) end end
  b:drawImage(a)
  b:drawPixel(2, 1, pc.rgba(255, 255, 255, 255))
  b:drawPixel(7, 5, pc.rgba(0, 0, 0, 255))
  b:drawPixel(0, 0, pc.rgba(1, 2, 3, 0)) -- transparent in both: equal
  local changed, bounds, img = b:diff(a, true)
  check("diff: count", changed == 2, changed)
  check("diff: bounds", bounds and bounds.x == 2 and bounds.y == 1 and bounds.width == 6 and bounds.height == 5, bounds and json.encode(bounds))
  check("diff: red at a change, faded elsewhere", pc.rgbaR(img:getPixel(2, 1)) == 255 and pc.rgbaA(img:getPixel(2, 1)) == 255
    and pc.rgbaA(img:getPixel(1, 0)) == 255 // 3)
  check("diff: equal images", (a:diff(a)) == 0 and select(2, a:diff(a)) == nil)
  check("diff: sizes must match", fails(function() a:diff(Image(2, 2, ColorMode.RGB)) end, "same size"))
  -- The Lua walk (stock Aseprite) agrees with the native one.
  local native, lua, luaDiff = StepCapture.measure(a, b), StepCapture.measureLua(a, b), StepCapture.diffLua(a, b)
  check("measure: native and Lua agree", native.changed == lua.changed and lua.changed == luaDiff.changed
    and native.bounds.x == lua.bounds.x and native.bounds.width == lua.bounds.width and native.bounds.height == luaDiff.bounds.height,
    native.changed .. " vs " .. lua.changed)
  check("diff image: native and Lua agree", StepCapture.diff(a, b).image:isEqual(luaDiff.image))
end

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
