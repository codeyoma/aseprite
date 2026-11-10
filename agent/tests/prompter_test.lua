-- Prompter (prompter.lua): the scripted adapter and the questions' text.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/prompter_test.lua
local extDir = app.params.ext
local Prompter = dofile(app.fs.joinPath(extDir, "prompter.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- A recording fallback in place of app.alert / app.tip.
local function recorder(index)
  local r = { asked = {}, tips = {} }
  r.ask = function(q) r.asked[#r.asked + 1] = q; return index end
  r.tip = function(t) r.tips[#r.tips + 1] = t end
  return r
end

-- Scripted adapter
do
  local fb = recorder(2)
  local p = Prompter.scripted(function(q) if q.id == "revert" then return 1 end end, fb)
  check("scripted answer", p.ask(Prompter.revertQuestion()) == 1 and #fb.asked == 0)
  check("unanswered falls back", p.ask(Prompter.discardQuestion()) == 2 and fb.asked[1].id == "discard")
  p.tip("hello")
  check("tips go to the fallback", fb.tips[1] == "hello")
  local yes = Prompter.scripted(function() return true end)
  local no = Prompter.scripted(function() return false end)
  check("true is the first button, false none", yes.ask(Prompter.revertQuestion()) == 1 and no.ask(Prompter.revertQuestion()) == 0)
  check("no answer and no fallback: 0", Prompter.scripted(nil).ask(Prompter.revertQuestion()) == 0)
end

-- Apply decision (#28)
do
  local q, tip = Prompter.applyQuestion{ branch = "dev/x", files = {} }
  check("nothing changed: tip", q == nil and tip == "The agent hasn't changed anything yet", tip)
  q, tip = Prompter.applyQuestion{ branch = "dev/x", files = { "a.lua" }, uncommitted = { "a.lua", "b.lua" } }
  check("uncommitted: tip", q == nil and tip:match("hasn't committed 2 file%(s%)"), tip)

  q = Prompter.applyQuestion{ branch = "dev/x", base = "agent", files = { "a.lua", "b.lua" }, needsBuild = false }
  check("scripts only: Relaunch", q.id == "apply" and q.buttons[1] == "Relaunch" and q.buttons[2] == "Cancel")
  check("apply lines", q.text[1] == "Branch dev/x: 2 file(s) changed"
    and q.text[2] == "Applying moves your agent branch to the agent's commits."
    and q.text[3] == "  a.lua" and q.text[#q.text] == "Only scripts changed: Aseprite will restart.", table.concat(q.text, "|"))
  check("question carries the status", q.status.branch == "dev/x")

  local files = {}
  for i = 1, 12 do files[i] = "f" .. i .. ".cpp" end
  q = Prompter.applyQuestion{ branch = "dev/y", files = files, needsBuild = true }
  check("C++: Rebuild && Relaunch", q.buttons[1] == "Rebuild && Relaunch")
  check("ten files, then ...", q.text[12] == "  f10.cpp" and q.text[13] == "  ..." and #q.text == 14, #q.text)
  check("no base: your branch", q.text[2] == "Applying moves your branch branch to the agent's commits.")
  check("rebuild line", q.text[14] == "C++ changed: Aseprite will be rebuilt, then restarted.")
end

-- Other questions
do
  local d = Prompter.discardQuestion()
  check("discard", d.id == "discard" and d.buttons[1] == "Discard" and #d.text == 3 and d.text[2]:match("git stash pop"))
  local dev = Prompter.developerQuestion()
  check("developer", dev.id == "developer" and dev.buttons[1] == "Turn on")
  local r = Prompter.revertQuestion()
  check("revert", r.id == "revert" and r.buttons[1] == "Revert anyway")
  local req = { text = "touch x", options = { { optionId = "a", name = "Allow" }, { optionId = "r" } } }
  local p = Prompter.permissionQuestion(req)
  check("permission buttons", p.id == "permission" and p.buttons[1] == "Allow" and p.buttons[2] == "r" and p.request == req)
  check("permission text", p.text[2] == "touch x")
  check("permission without options: OK", Prompter.permissionQuestion{}.buttons[1] == "OK")
  local n = Prompter.notice("Discard", "failed")
  check("notice", n.buttons[1] == "OK" and n.text == "failed")
end

print(failures == 0 and "ALL PROMPTER TESTS PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " prompter tests failed") end
