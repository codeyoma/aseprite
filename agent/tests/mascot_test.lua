-- The mascot (mascot.lua) and its moods (mascot_mood.lua), in batch mode.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/mascot_test.lua
local M = dofile(app.fs.joinPath(app.params.ext, "mascot.lua"))
local Mood = dofile(app.fs.joinPath(app.params.ext, "mascot_mood.lua"))
local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Every listed mood exists, is drawable and stays inside size().
local listed, count = {}, 0
for _, g in ipairs(M.GROUPS) do for _, n in ipairs(g[2]) do listed[n] = true; count = count + 1 end end
check("56 moods in 11 groups", count == 56 and #M.GROUPS == 11, count)
for n in pairs(M.MOODS) do check("mood " .. n .. " is listed", listed[n]) end
local w, h = M.size(2)
local bad = {}
for n in pairs(listed) do
  if not M.MOODS[n] then bad[#bad + 1] = n .. " missing" else
    for i = 0, math.floor(M.length(n) * 10) do
      local f = M.frame(n, i / 10)
      local gc = { fillRect = function(_, r)
        if r.x < 0 or r.y < 0 or r.x + r.width > w or r.y + r.height > h then bad[#bad + 1] = n end
      end }
      M.draw(gc, 0, 0, 2, f)
      if f.e and not M.EYE_STYLES[f.e] then bad[#bad + 1] = n .. " eye " .. f.e end
      if f.i and not M.ICONS[f.i] then bad[#bad + 1] = n .. " icon " .. f.i end
    end
  end
end
check("every frame draws inside its size, with known eyes and icons", #bad == 0, table.concat(bad, ", "))
check("open eyes blink", M.frame("idle", M.BLINK_EVERY + 0.05).blink == true)
check("labels", M.label("deep_thinking") == "Deep thinking" and M.label("idle") == "Ready")

-- Moods from events.
local m = Mood.new()
m:greet(0)
check("greets", (m:current(0.5)) == "greet")
check("idles after", (m:current(3)) == "idle")
check("looks around later", (m:current(8)) == "look_around")
check("sleeps after a while", (m:current(Mood.SLEEP_AFTER + 1)) == "sleepy")
m:send(200, { attachments = true })
check("wakes with a stretch", (m:current(200.5)) == "stretch")
check("then reads the attachment", (m:current(202)) == "reading")
m:event({ type = "thinking" }, 202)
check("thinks", (m:current(203)) == "thinking")
check("thinks deeply when it takes long", (m:current(202 + Mood.DEEP_AFTER + 1)) == "deep_thinking")
m:event({ type = "tool", name = "put_images", kind = "edit" }, 212)
check("eureka after long thought, then draws", (m:current(212.2)) == "eureka" and (m:current(213.5)) == "drawing")
m:event({ type = "tool_result", ok = false }, 214)
check("retries after a failure", (m:current(214.2)) == "retry")
m:event({ type = "tool", name = "check", kind = "read" }, 215)
check("checks", (m:current(215.6)) == "checking")
check("loading when a tool takes long", (m:current(215 + Mood.LOADING_AFTER + 0.5)) == "loading")
m:event({ type = "tool_result", ok = true }, 219)
m:event({ type = "tool", name = "read_guide", kind = "read" }, 220)
m:event({ type = "tool_result", ok = true }, 220.5)
check("found after a search", (m:current(220.7)) == "found")
m:hold(true, 221)
check("waits for its sprite's tab", (m:current(222)) == "waiting")
m:hold(false, 223)
m:event({ type = "permission" }, 224)
check("needs approval", (m:current(224.5)) == "need_approval")
m:event({ type = "done" }, 230)
check("done", (m:current(230.5)) == "done")
check("idle after done", (m:current(234)) == "idle")
for i = 1, 8 do m:event({ type = "tool", name = "put_images", kind = "edit" }, 240 + i) end
m:event({ type = "done" }, 250)
check("celebrates many edits", (m:current(250.5)) == "celebrate")
m:send(260, {})
m:event({ type = "error", text = "boom" }, 261)
check("error", (m:current(262)) == "error")
m:send(270, {})
m:event({ type = "text", text = "Which palette do you want?" }, 271)
m:event({ type = "done" }, 272)
check("asks when the reply ends with a question", (m:current(273)) == "asking")
m:answered(280)
check("answered clears asking", (m:current(281)) ~= "asking")
m:send(290, {})
m:event({ type = "done", text = "Stopped." }, 291)
check("apologetic when stopped", (m:current(292)) == "apologetic")
local q = Mood.new()
q:queued(true, 10)
check("queued: waiting, then impatient", (q:current(11)) == "waiting" and (q:current(10 + Mood.IMPATIENT_AFTER + 1)) == "impatient")
check("tool moods", Mood.toolMood("spawn_agents") == "handoff" and Mood.toolMood("execute_lua") == "building"
  and Mood.toolMood("export_godot") == "saving" and Mood.toolMood("delete_layer", nil, "edit") == "deleting"
  and Mood.toolMood("apply_timeline_text", nil, "edit") == "organizing")
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
