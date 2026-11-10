-- Batch-mode test for the extension's request handlers.
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/batch_test.lua

local extDir = app.params.ext
-- Document Handlers are tested through their interface; no plugin, no bridge.
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local A = { getState = H.getState, executeLua = H.executeLua, snapshot = H.snapshot, handlers = H.handlers,
            protocol = function() return P end }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- No sprite yet
local st = A.getState()
check("state without sprite", st.activeSprite == nil and st.asepriteVersion ~= nil)

-- Create a sprite through execute_lua
local r = A.executeLua{ code = [[
  local s = Sprite(16, 8)
  s.layers[1].name = "Body"
  local l = s:newLayer(); l.name = "Shadow"
  s:newFrame()
  s:newTag(1, 2).name = "idle"
  local img = Image(16, 8)
  img:drawPixel(0, 0, Color(255, 0, 0))
  img:drawPixel(15, 7, Color(0, 0, 255, 128))
  s:newCel(s.layers[1], 1, img, Point(0, 0))
  print("made", s.width, s.height)
  return { w = s.width, h = s.height, layers = #s.layers }
]] }
check("execute_lua ok", r.ok, r.error)
check("execute_lua value", r.ok and r.value.w == 16 and r.value.layers == 2)
check("execute_lua print", r.output[1] == "made\t16\t8", r.output[1])

st = A.getState()
local s = st.activeSprite
check("state sprite", s and s.width == 16 and s.height == 8 and s.frameCount == 2)
check("state layers top-first", s and s.layers[1].name == "Shadow" and s.layers[2].name == "Body")
check("state tag", s and s.tags[1] and s.tags[1].name == "idle" and s.tags[1].to == 2)
check("state json-encodable", pcall(json.encode, st))
check("state active layer", st.activeLayer ~= nil, st.activeLayer)

r = A.executeLua{ code = [[
  local g = app.sprite:newGroup(); g.name = "Grp"
  local inner = app.sprite:newLayer(); inner.name = "Inner"; inner.parent = g
  app.layer = inner
  return app.layer
]] }
check("return userdata", r.ok and r.value and r.value.layer == "Inner", r.error)
check("nested layer path", A.getState().activeLayer == "Grp/Inner", A.getState().activeLayer)
A.handlers.undo{ steps = 1 }

-- Errors roll back
local before = #app.sprite.layers
r = A.executeLua{ code = [[ app.sprite:newLayer(); error("boom") ]] }
check("error reported", not r.ok and r.error:find("boom") ~= nil, r.error)
check("error rolled back", #app.sprite.layers == before, #app.sprite.layers)

r = A.executeLua{ code = "this is not lua" }
check("compile error", not r.ok and r.error:find("Compile error") ~= nil, r.error)

-- Snapshot
local header, bytes = A.snapshot{ frame = 1 }
check("snapshot size", header.width == 16 and header.height == 8 and #bytes == 16 * 8 * 4, #bytes)
check("snapshot pixel (0,0) red", bytes:byte(1) == 255 and bytes:byte(2) == 0 and bytes:byte(4) == 255)
header, bytes = A.snapshot{ frame = 1, layer = "Body" }
check("layer snapshot", #bytes == 16 * 8 * 4)
check("snapshot bad layer", not pcall(A.snapshot, { layer = "Nope" }))

-- Indexed sprite layer snapshot
r = A.executeLua{ code = [[ app.command.ChangePixelFormat{ format = "indexed", ui = false } ]] }
check("convert to indexed", r.ok, r.error)
header, bytes = A.snapshot{ frame = 1, layer = "Body" }
do
  -- Conversion maps red to the nearest palette entry; expect that entry's color.
  local cel = app.sprite.layers[1]:cel(1)
  local c = app.sprite.palettes[1]:getColor(cel.image:getPixel(0, 0))
  check("indexed layer snapshot uses palette",
    bytes:byte(1) == c.red and bytes:byte(2) == c.green and bytes:byte(3) == c.blue and bytes:byte(4) == 255,
    string.format("%d,%d,%d vs %d,%d,%d", bytes:byte(1), bytes:byte(2), bytes:byte(3), c.red, c.green, c.blue))
end

-- Undo handler
local layersNow = #app.sprite.layers
A.executeLua{ code = [[ app.sprite:newLayer() ]] }
A.handlers.undo{ steps = 1 }
check("undo", #app.sprite.layers == layersNow, #app.sprite.layers)

-- M2: run_command, get_context, read_pixels
do
  local spr = Sprite(8, 4)
  app.sprite = spr
  local img = Image(8, 4)
  img:drawPixel(1, 0, Color(255, 0, 0))
  img:drawPixel(2, 0, Color(0, 255, 0))
  img:drawPixel(1, 1, Color(255, 0, 0))
  spr:newCel(spr.layers[1], 1, img, Point(0, 0))

  local res = A.handlers.run_command{ name = "CanvasSize", params = { right = 4, bottom = 2 } }
  check("run_command CanvasSize", res.executed and spr.width == 12 and spr.height == 6, spr.width .. "x" .. spr.height)

  res = A.handlers.run_command{ name = "SpriteSize", params = { width = 24, height = 12, method = "nearest" } }
  check("run_command SpriteSize", res.executed and spr.width == 24, spr.width)
  A.handlers.undo{ steps = 2 }
  check("undo commands", spr.width == 8, spr.width)

  check("run_command unknown", not pcall(A.handlers.run_command, { name = "NoSuchCommand" }))

  res = A.handlers.run_command{ name = "ReplaceColor", params = { from = { __color = "#ff0000" }, to = { __color = "#0000ff" }, tolerance = 0 } }
  local cel = spr.layers[1]:cel(1)
  -- Filters trim the cel, so read relative to cel.position.
  local px = cel.image:getPixel(1 - cel.position.x, 0 - cel.position.y)
  check("run_command color param", res.executed and app.pixelColor.rgbaB(px) == 255 and app.pixelColor.rgbaR(px) == 0, res.note)
  A.handlers.undo{ steps = 1 }

  local ctx = A.handlers.get_context()
  check("get_context", ctx.sprite and ctx.sprite.width == 8 and ctx.layer and ctx.frame == 1 and ctx.cel ~= nil, json.encode(ctx))
  check("get_context json", pcall(json.encode, ctx))

  local px = A.handlers.read_pixels{ x = 0, y = 0, width = 4, height = 2 }
  check("read_pixels rows", #px.rows == 2 and px.rows[1] == ". 0 1 ." and px.rows[2] == ". 0 . .", px.rows[1] .. " / " .. px.rows[2])
  check("read_pixels legend", px.legend["0"] == "#ff0000" and px.legend["1"] == "#00ff00", json.encode(px.legend))
  check("read_pixels out of bounds", A.handlers.read_pixels{ x = 7, y = 0, width = 2, height = 1 }.rows[1] == ". -")
  check("read_pixels too large", not pcall(A.handlers.read_pixels, { width = 200, height = 200 }))

  A.executeLua{ code = [[ app.command.ChangePixelFormat{ format = "indexed", ui = false } ]] }
  px = A.handlers.read_pixels{ x = 0, y = 0, width = 3, height = 1 }
  check("read_pixels indexed keys", px.keys == "palette-index" and px.rows[1]:match("^%. %d+ %d+$") ~= nil, px.rows[1])
end

-- Contract with protocol.json (the bridge checks its side in test/protocol.test.mjs)
do
  local P = A.protocol()
  local missing, extra = {}, {}
  for m in pairs(P.requests) do if not A.handlers[m] then missing[#missing + 1] = m end end
  for m in pairs(A.handlers) do if not P.requests[m] then extra[#extra + 1] = m end end
  check("every protocol request has a handler", #missing == 0, table.concat(missing, ","))
  check("every handler is a protocol request", #extra == 0, table.concat(extra, ","))

  local header, bytes = A.handlers.snapshot{ frame = 1 }
  check("binary request returns data as a second value", P.requests.snapshot.binary and type(bytes) == "string" and header.width ~= nil)

  local Conversation = dofile(app.fs.joinPath(extDir, "conversation.lua"))
  local c = Conversation.new{}
  c:send("x", "claude")
  local ok = true
  for _, t in ipairs(P.notifications["chat.event"].types) do
    if not pcall(c.apply, c, { type = t, id = "1", text = "t", tool = "t", ok = true }) then ok = false end
  end
  check("Conversation accepts every chat.event type", ok)
end

-- State block (#18)
do
  local previous = app.sprite
  local spr = Sprite(32, 16, ColorMode.INDEXED)
  app.sprite = spr
  local body = spr.layers[1]; body.name = "Body"
  local g = spr:newGroup(); g.name = "FX"
  local glow = spr:newLayer(); glow.name = "Glow"; glow.parent = g; glow.opacity = 128
  local hidden = spr:newLayer(); hidden.name = "Sketch"; hidden.isVisible = false
  for _ = 1, 3 do spr:newEmptyFrame() end
  for _, f in ipairs(spr.frames) do f.duration = 0.1 end
  local tag = spr:newTag(1, 3); tag.name = "idle"; tag.aniDir = AniDir.PING_PONG
  spr.selection = Selection(Rectangle(2, 3, 4, 5))
  app.layer = body

  local block = H.stateBlock()
  local lines = {}
  for l in block:gmatch("[^\n]+") do lines[#lines + 1] = l end
  check("state: fenced as data", lines[1]:match("^<aseprite%-state note=") and lines[#lines] == "</aseprite-state>")
  check("state: sprite line", block:match("sprite: Sprite 32x16 indexed, 4 frames, 10 fps") ~= nil, lines[2])
  check("state: palette truncated with count", block:match("palette: 256 colors .- %(%+240%)") ~= nil)
  local order = {}
  for name in block:gmatch("%[L%d+%] (%w+)") do order[#order + 1] = name end
  check("state: layers top to bottom, groups nested", table.concat(order, ",") == "Sketch,FX,Glow,Body", table.concat(order, ","))
  check("state: layer flags", block:match("Sketch %(hidden%)") and block:match("Glow %(50%%%)") and block:match("FX %(group%)") and block:match("Body %(active%)"))
  check("state: indented group child", block:match("\n    %[L%d+%] Glow") ~= nil)
  check("state: tags", block:match("tags: idle 1%-3 ping%-pong") ~= nil)
  check("state: active line", block:match("active: layer L%d+ Body, frame %d+") ~= nil)
  check("state: pixel selection", block:match("pixel selection: x=2 y=3 4x5") ~= nil)
  check("state: deterministic and ids stable", H.stateBlock() == block)

  local id = "L" .. glow.id
  check("layerById by id and name", H.layerById(id) == glow and H.layerById(glow.id) == glow and H.layerById("Body") == body)
  local r = H.executeLua{ code = "return layerById('" .. id .. "').name" }
  check("layerById in agent code", r.ok and r.value == "Glow", r.error)

  -- Budget: 20 layers and 64 colors stay well under ~1.5k tokens (~6000 chars).
  local big = Sprite(64, 64)
  app.sprite = big
  for i = 1, 19 do big:newLayer().name = "Layer number " .. i end
  big.palettes[1]:resize(64)
  local n = #H.stateBlock()
  check("state: size budget", n < 6000, n)
  for i = 1, 45 do big:newLayer() end
  check("state: long layer lists truncated", H.stateBlock():match("%(%+%d+ more layers%)") ~= nil)
  big:close()
  app.sprite = spr
  spr:close()
  if previous then app.sprite = previous end
end

-- aseprite:// URIs (#20): serialize -> resolve round trip, select, stale
do
  local previous = app.sprite
  local U = H.Uri
  local spr = Sprite(16, 16)
  app.sprite = spr
  local body = spr.layers[1]; body.name = "Body"
  local fx = spr:newLayer(); fx.name = "F X"
  spr:newEmptyFrame(); spr:newEmptyFrame()
  local walk = spr:newTag(2, 3); walk.name = "walk left"
  local slice = spr:newSlice(Rectangle(1, 1, 4, 4)); slice.name = "hit box"
  spr.selection = Selection(Rectangle(0, 0, 3, 3))

  local r = U.resolve(U.layer(fx))
  check("uri layer", U.layer(fx) == "aseprite://layer/L" .. fx.id and r and r.layer == fx and r.label == "F X")
  r = U.resolve(U.frame(3)); check("uri frame", r and r.frame == 3)
  r = U.resolve(U.tag(walk)); check("uri tag (encoded)", U.tag(walk) == "aseprite://tag/walk%20left" and r and r.tag == walk)
  r = U.resolve(U.cel(body, 2)); check("uri cel", r and r.layer == body and r.frame == 2)
  r = U.resolve(U.palette(5)); check("uri palette", r and r.index == 5 and r.label:match("^color 5 #"))
  r = U.resolve(U.slice(slice)); check("uri slice", r and r.slice == slice)
  r = U.resolve(U.selection()); check("uri selection", r and r.kind == "selection")

  check("select layer", U.select(U.layer(body)) and app.layer == body)
  check("select frame", U.select(U.frame(2)) and app.frame.frameNumber == 2)
  check("select cel", U.select(U.cel(fx, 3)) and app.layer == fx and app.frame.frameNumber == 3)
  check("select tag", U.select(U.tag(walk)) and app.frame.frameNumber == 2)

  local stale = U.layer(fx)
  spr:deleteLayer(fx)
  check("stale uri resolves to nil", U.resolve(stale) == nil and U.select(stale) == false)
  check("malformed uris", U.resolve("aseprite://layer/xyz") == nil and U.resolve("https://x") == nil
    and U.resolve("aseprite://frame/99") == nil and U.resolve("aseprite://palette/999") == nil)

  local t = U.targets()
  local groups = {}
  for _, x in ipairs(t) do groups[x.group] = true end
  check("picker targets", groups["Layers"] and groups["Tags"] and groups["Frames"] and groups["Palette"] and groups["Slices"]
    and t[1].name == "selection")
  spr:close()
  if previous then app.sprite = previous end
end

-- H.call: the interface the bridge connection uses
do
  local header, bytes = H.call("snapshot", { frame = 1 })
  check("call returns binary data for binary requests", type(bytes) == "string" and header.width ~= nil)
  local ok, err = pcall(H.call, "format_disk", {})
  check("call refuses methods outside the protocol", not ok and type(err) == "table" and err.code == -32601)
  check("contextString describes the active sprite", H.contextString():match("^sprite ") ~= nil, H.contextString())
end

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
