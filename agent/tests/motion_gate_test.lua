-- Motion stage gate (#99): in a "keys" stage an agent edit may change only the key frames of the tag.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/motion_gate_test.lua
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

local s = Sprite(8, 8, ColorMode.RGB)
for i = 1, 6 do s:newFrame() end -- 7 frames: walk 1-6, frame 7 outside the tag
local body = s.layers[1]; body.name = "Body"
s:newCel(body, 1, Image(8, 8, ColorMode.RGB), Point(0, 0))
local walk = s:newTag(1, 6); walk.name = "walk"
local function setStage(stage)
  s.properties("aseprite-agent")["concept.spec"] = json.encode{ motion = { tag = "walk", keys = { 1, 3, 4, 6 }, stage = stage, walk = true } }
end
local function draw(frame)
  return string.format([[local l = app.sprite.layers[1]
    local c = l:cel(%d) or app.sprite:newCel(l, %d, Image(8, 8, ColorMode.RGB), Point(0, 0))
    local img = c.image:clone(); img:drawPixel(1, 1, Color(255, 0, 0)); c.image = img]], frame, frame)
end
local function drawn(frame) local c = body:cel(frame); return c ~= nil and c.image:getPixel(1, 1) ~= 0 end

setStage("keys")
local r = H.call("execute_lua", { code = draw(3) })
check("a key frame can be drawn", r.ok and drawn(3))
local ok, err = pcall(H.call, "execute_lua", { code = draw(2) })
check("an in-between is refused in the keys stage", not ok and tostring(err):match('frame 2 %(layer "Body"%) changed')
  and tostring(err):match("draw only the key frames %(1, 3, 4, 6%)") and tostring(err):match("undone"), err)
check("and undone", not drawn(2))
ok, err = pcall(H.call, "execute_lua", { code = draw(4) .. "\n" .. draw(5) })
check("a script that draws a key and an in-between is undone whole", not ok and not drawn(4) and not drawn(5), err)
r = H.call("execute_lua", { code = draw(7) })
check("frames outside the tag stay free", r.ok and drawn(7))
ok, err = pcall(H.call, "execute_lua", { code = "app.sprite:newFrame()\n" .. draw(2) })
check("adding a frame doesn't open the in-betweens", not ok and not drawn(2), err)
r = H.call("execute_lua", { code = "return 1" })
check("reads and no-op scripts run", r.ok)

setStage("inbetweens")
r = H.call("execute_lua", { code = draw(2) })
check("after advance the in-betweens can be drawn", r.ok and drawn(2))
s.properties("aseprite-agent")["concept.spec"] = ""
r = H.call("execute_lua", { code = draw(5) })
check("no stage: no gate", r.ok and drawn(5))

-- The Motion Clip store (#109): keys are tag-relative, and every clip in its keys stage is gated.
local idle = s:newTag(7, 7); idle.name = "idle"
s:newEmptyFrame(); s:newEmptyFrame() -- frames 8, 9
local run = s:newTag(7, 9); run.name = "run"
local function store(stage)
  s.properties("aseprite-agent")["motion"] = json.encode{ version = 1, rigs = {}, clips = {
    walk = { kind = "walk", facing = "right", loop = true, keys = { { at = 1 }, { at = 4 } }, stage = stage },
    run = { kind = "run", facing = "right", loop = true, keys = { { at = 1 } }, stage = "keys" },
  } }
end
store("keys")
ok, err = pcall(H.call, "execute_lua", { code = draw(6) })
check("the store gates the walk's non-keys", not ok and not drawn(6) and tostring(err):match('Motion clip "walk"'), err)
r = H.call("execute_lua", { code = draw(4) })
check("a tag-relative key can be drawn", r.ok and drawn(4))
ok, err = pcall(H.call, "execute_lua", { code = draw(8) })
check("a second clip in its keys stage is gated too", not ok and not drawn(8) and tostring(err):match('Motion clip "run"'), err)
store("inbetweens")
r = H.call("execute_lua", { code = draw(6) })
check("the walk's in-betweens open after advance", r.ok and drawn(6))
s.properties("aseprite-agent")["motion"] = ""

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
