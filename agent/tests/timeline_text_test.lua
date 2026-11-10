-- Timeline as text (#32): serialize, round trip, plan, apply, errors.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/timeline_text_test.lua
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
local function has(list, s) for _, x in ipairs(list) do if x == s then return true end end return false end

-- Fixture: 6 frames, two tags, a Shadow layer linked in 4-6.
local s = Sprite(8, 8)
for i = 1, 5 do s:newFrame() end
for f = 1, 6 do s.frames[f].duration = f <= 2 and 0.1 or 0.08 end
local idle = s:newTag(1, 2); idle.name = "idle"; idle.aniDir = AniDir.PING_PONG
local walk = s:newTag(3, 6); walk.name = "walk"; walk.repeats = 2
local shadow = s:newLayer(); shadow.name = "Shadow"
for f = 1, 6 do s:newCel(shadow, f, Image(8, 8), Point(0, 0)) end
app.range.layers = { shadow }; app.range.frames = { s.frames[4], s.frames[5], s.frames[6] }
app.command.LinkCels(); app.range:clear()

local text = H.call("get_timeline_text", {}).text
local expected = table.concat({
  "frames 6",
  "frame 1-2 duration 100ms",
  "frame 3-6 duration 80ms",
  "tag idle 1-2 ping-pong",
  "tag walk 3-6 forward repeat=2",
  "layer Shadow link 4-6",
}, "\n") .. "\n"
check("serialize", text == expected, "\n" .. text)

local r = H.call("apply_timeline_text", { text = text })
check("round trip changes nothing", r.ok and #r.changes == 0 and not r.applied, #r.changes)

-- Plan: walk becomes 8 frames at 100 ms ping-pong.
local edited = [[
frames 8
frame 1-2 duration 100ms
frame 3-8 duration 100ms   # walk at 10 fps
tag idle 1-2 ping-pong
tag walk 3-8 ping-pong
layer Shadow unlink 4-6
]]
local undoBefore = #s.frames
r = H.call("apply_timeline_text", { text = edited, plan = true })
check("plan lists changes", r.ok and has(r.changes, "Frame count 6 -> 8 (new frames copy the last one)")
  and has(r.changes, "Frames 3-6 duration 80ms -> 100ms") and has(r.changes, "Tag walk 3-6 -> 3-8")
  and has(r.changes, "Tag walk forward -> ping-pong") and has(r.changes, "Tag walk repeat 2 -> 0")
  and has(r.changes, "Unlink Shadow cels 4-6"), table.concat(r.changes, " | "))
check("plan does not apply", #s.frames == undoBefore and not r.applied)

r = H.call("apply_timeline_text", { text = edited })
check("apply", r.applied and #s.frames == 8 and s.frames[8].duration == 0.1 and s.tags[2].toFrame.frameNumber == 8
  and s.tags[2].aniDir == AniDir.PING_PONG and shadow:cel(5).image.id ~= shadow:cel(4).image.id)
check("tag removed when not listed", (function()
  H.call("apply_timeline_text", { text = "tag walk 3-8 ping-pong" })
  return #s.tags == 1 and s.tags[1].name == "walk"
end)())
app.undo(); app.undo()
check("apply is one undo step each", #s.frames == 6 and #s.tags == 2 and s.frames[3].duration == 0.08
  and shadow:cel(5).image.id == shadow:cel(4).image.id)

-- fps line and links.
r = H.call("apply_timeline_text", { text = "fps 12\nlayer Shadow link 1-3" .. "\ntag idle 1-2 ping-pong\ntag walk 3-6 forward repeat=2" })
check("fps and link", r.applied and s.frames[1].duration == 0.083 and shadow:cel(3).image.id == shadow:cel(1).image.id,
  s.frames[1].duration)

-- Errors with line numbers; nothing applied.
r = H.call("apply_timeline_text", { text = "frames 6\ntg idle 1-2\ntag walk 3-9\nframe 2 duration fast\nlayer Nope link 1-2" })
check("parse errors", not r.ok and r.errors[1] == "line 2: unknown line 'tg' (use frames, fps, frame, tag or layer)"
  and r.errors[2] == "line 4: expected: frame <A-B> duration <N>ms", table.concat(r.errors, " | "))
r = H.call("apply_timeline_text", { text = "tag walk 3-9\nlayer Nope link 1-2" })
check("range and layer errors", not r.ok and r.errors[1] == "line 1: tag walk 3-9 is past the last frame (6)"
  and r.errors[2] == "line 2: no layer 'Nope'", table.concat(r.errors, " | "))

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
