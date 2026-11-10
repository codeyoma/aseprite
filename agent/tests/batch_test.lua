-- Batch-mode test for the extension's request handlers.
-- Run: ASEPRITE_AGENT_TEST=1 aseprite -b --script-param ext=<agent/extension> --script agent/tests/batch_test.lua

local extDir = app.params.ext
local fakePlugin = {
  path = extDir,
  preferences = { autoconnect = false },
  newMenuGroup = function() end,
  newCommand = function() end,
}
dofile(app.fs.joinPath(extDir, "agent.lua"))
init(fakePlugin)
local A = __aseprite_agent
assert(A, "test hooks missing; set ASEPRITE_AGENT_TEST=1")

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

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
