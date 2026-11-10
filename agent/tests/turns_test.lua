-- Turn controller (turns.lua): a reply's lifecycle driven by chat events,
-- with a fake Turn History, a fake capture and a fake clock.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/turns_test.lua
local extDir = app.params.ext
local Turns = dofile(app.fs.joinPath(extDir, "turns.lua"))
local Conversation = dofile(app.fs.joinPath(extDir, "conversation.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- A fake Turn History: records calls; status and revert are scripted per turn.
local function fakeHistory()
  local H = { calls = {} }
  local function log(s) H.calls[#H.calls + 1] = s end
  function H.begin(sprite) log("begin"); return { sprite = sprite, start = 1 } end
  function H.finish(turn, sprite) log("finish"); turn.finish = 2; turn.finishedOn = sprite; return turn end
  function H.status(turn) return turn.status or "done" end
  function H.canRevert(turn) return turn.canRevert ~= false end
  function H.hasLaterEdits(turn) return turn.laterEdits or false end
  function H.revert(turn, force)
    log("revert" .. (force and "!" or ""))
    if turn.laterEdits and not force then return false, "You edited after this reply" end
    turn.status = "undone"
    return true
  end
  function H.restore(turn) log("restore"); turn.status = "done"; return true end
  function H.changesSince(turn) return "changes of " .. tostring(turn.sprite) end
  return H
end

-- A fake capture: seq() and claim(since) with the arguments recorded.
local function fakeCapture()
  local C = { n = 0, claims = {} }
  function C:seq() return self.n end
  function C:claim(since) self.claims[#self.claims + 1] = since; return { changed = 7, since = since } end
  return C
end

local function setup()
  local now = 100
  local H, cap = fakeHistory(), fakeCapture()
  local active = "spriteA"
  local turns = Turns.new{ Conversation = Conversation, clock = function() return now end,
    history = H, capture = cap, sprite = function() return active end }
  return turns, H, cap, function(s) active = s end, function(t) now = t end
end

local function headerOf(turns)
  for _, e in ipairs(turns.conversation:entries()) do if e.kind == "header" then return e end end
end

-- A reply: start, an edit step, a read step, done.
do
  local turns, H, cap, setActive, setNow = setup()
  cap.n = 4
  local turn = turns:start("spriteA", { text = "make it blue", provider = "claude", mode = "agent" })
  check("start records the turn", turn and turn.captureSeq == 4 and turns:currentTurn() == turn)
  check("start sends the message", turns:isBusy() and headerOf(turns) and headerOf(turns).text == "Claude")
  check("no view while running", turns:view(headerOf(turns)) == nil)

  turns:apply{ type = "tool", id = "t1", tool = "Fill", kind = "edit" }
  turns:apply{ type = "tool_result", id = "t1", ok = true }
  turns:apply{ type = "tool", id = "t2", tool = "Look", kind = "read" }
  turns:apply{ type = "tool_result", id = "t2", ok = true }
  turns:apply{ type = "tool", id = "t3", tool = "Fail", kind = "edit" }
  turns:apply{ type = "tool_result", id = "t3", ok = false }
  local tools = {}
  for _, e in ipairs(turns.conversation:entries()) do if e.kind == "tool" then tools[e.id] = e end end
  check("edit step claims captures since the start", tools.t1.capture and tools.t1.capture.since == 4 and #cap.claims == 1)
  check("read and failed steps claim nothing", not tools.t2.capture and not tools.t3.capture)

  -- A refined tool_result for the same step does not claim twice.
  turns:apply{ type = "tool_result", id = "t1", ok = true }
  check("a step claims once", #cap.claims == 1, #cap.claims)

  setNow(130)
  setActive("spriteB")
  local r = turns:apply{ type = "done" }
  check("done ends the turn", r.turnEnded and not turns:isBusy() and turns:currentTurn() == nil)
  check("finish on the active sprite", turn.finishedOn == "spriteB" and turns:lastTurn() == turn)
  local worked
  for _, e in ipairs(turns.conversation:entries()) do if e.kind == "worked" then worked = e end end
  check("worked time from the clock", worked and worked.secs == 30, worked and worked.secs)

  -- changesSince only on the reply's sprite.
  check("no changes on another sprite", turns:changesSince() == nil)
  setActive("spriteA")
  check("changes on the reply's sprite", turns:changesSince() == "changes of spriteA")

  local status, action = turns:view(headerOf(turns))
  check("view: done offers revert", status == "done" and action == "revert", tostring(status) .. " " .. tostring(action))
  local ok = turns:action(headerOf(turns), "revert")
  status, action = turns:view(headerOf(turns))
  check("revert, then restore is offered", ok and status == "undone" and action == "restore")
  ok = turns:action(nil, "restore")
  check("restore the last reply (nil header)", ok and turns:view(nil) == "done")
end

-- Error events and fail() finish the turn too.
do
  local turns, H = setup()
  turns:start("spriteA", { text = "x", provider = "codex" })
  local r = turns:apply{ type = "error", text = "boom" }
  check("error ends the turn", r.turnEnded and turns:lastTurn() ~= nil and H.calls[#H.calls] == "finish")

  turns:start("spriteA", { text = "y", provider = "codex" })
  turns:fail("Could not reach the bridge")
  local list = turns.conversation:entries()
  check("fail ends the turn with an error entry", not turns:isBusy() and turns:currentTurn() == nil
    and list[#list - 1].kind == "error" and list[#list - 1].text == "Could not reach the bridge")
  local finishes = 0
  for _, c in ipairs(H.calls) do if c == "finish" then finishes = finishes + 1 end end
  check("each turn finished once", finishes == 2, finishes)
  -- A stray done after the turn ended does not finish again.
  turns:apply{ type = "done" }
  finishes = 0
  for _, c in ipairs(H.calls) do if c == "finish" then finishes = finishes + 1 end end
  check("stray done finishes nothing", finishes == 2, finishes)
end

-- Events outside a turn (no start) claim nothing.
do
  local turns, _, cap = setup()
  turns:apply{ type = "tool", id = "t1", tool = "Fill", kind = "edit" }
  turns:apply{ type = "tool_result", id = "t1", ok = true }
  check("no claim without a running turn", #cap.claims == 0)
  check("no changes before any reply", turns:changesSince() == nil)
  check("no last reply to revert", select(1, turns:action(nil, "revert")) == false)
end

-- Revert over later edits needs force.
do
  local turns, H = setup()
  turns:start("spriteA", { text = "x", provider = "claude" })
  turns:apply{ type = "done" }
  local turn = turns:lastTurn()
  turn.laterEdits = true
  local ok, why, needsForce = turns:action(nil, "revert")
  check("later edits: refused, needs force", not ok and why and needsForce == true)
  ok = turns:action(nil, "revert", true)
  check("forced revert", ok and H.calls[#H.calls] == "revert!")
  -- Refusals for other reasons don't ask.
  turn.status, turn.canRevert = "done", false
  ok, why, needsForce = turns:action(nil, "revert")
  check("cannot revert: no force offered", not needsForce)
  check("view without revert when it can't", select(2, turns:view(nil)) == nil)
end

-- Without a capture, edit steps just have none.
do
  local turns = Turns.new{ Conversation = Conversation, clock = function() return 0 end, history = fakeHistory(),
    sprite = function() return "s" end }
  local turn = turns:start("s", { text = "x", provider = "claude" })
  turns:apply{ type = "tool", id = "t1", tool = "Fill", kind = "edit" }
  turns:apply{ type = "tool_result", id = "t1", ok = true }
  check("no capture dep: captureSeq 0, no claim", turn.captureSeq == 0)
end

print(failures == 0 and "ALL TURNS TESTS PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " turns tests failed") end
