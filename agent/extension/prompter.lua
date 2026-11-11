-- Prompter: how the Chat Panel asks the user something or shows a tip. One
-- interface with two adapters:
--
--   local Prompter = dofile("prompter.lua")
--   local p = Prompter.app()                     -- app.alert / app.tip
--   local p = Prompter.scripted(answer, fallback) -- tests: answer(question) -> index
--   p.ask{ id, title, text, buttons }           -- -> button index (0: closed)
--   p.tip(text)
--
-- The questions themselves are pure functions of what they ask about
-- (developerQuestion, applyQuestion, discardQuestion, revertQuestion,
-- permissionQuestion), so their text and buttons are tested in batch mode.
-- Each carries an `id` ("developer", "apply", "discard", "revert",
-- "permission") that scripted answers dispatch on.

local Prompter = {}

-- Asks with a modal alert and shows tips in the status bar.
function Prompter.app()
  return {
    ask = function(q) return app.alert{ title = q.title, text = q.text, buttons = q.buttons } end,
    tip = function(text) app.tip(text) end,
  }
end

-- Answers with answer(question): a button index, true (the first button)
-- or false (none, like closing the alert). When answer is nil or returns
-- nil, the fallback prompter asks instead (none: 0). Tips go to the
-- fallback too.
function Prompter.scripted(answer, fallback)
  local p = {}
  function p.ask(q)
    local i
    if answer then i = answer(q) end
    if i == true then return 1 end
    if i == false then return 0 end
    if i ~= nil then return i end
    return fallback and fallback.ask(q) or 0
  end
  function p.tip(text)
    if fallback then fallback.tip(text) end
  end
  return p
end

---------------------------------------------------------------------------
-- Questions
---------------------------------------------------------------------------

-- The first use of Developer mode (#28).
function Prompter.developerQuestion()
  return { id = "developer", title = "Developer mode", text = {
    "In Developer mode the agent edits this Aseprite fork's source code",
    "and can run commands in the repository (it asks you first).",
    "Its changes go on a dev/ branch; Rebuild & Relaunch applies them.",
  }, buttons = { "Turn on", "Cancel" } }
end

-- Rebuild & Relaunch (#28): what dev.status says decides whether to ask.
-- Returns the question, or nil and a tip saying why there is nothing to apply.
-- st: { branch, base, files, uncommitted, needsBuild }.
function Prompter.applyQuestion(st)
  local files = st.files or {}
  if #files == 0 then return nil, "The agent hasn't changed anything yet" end
  if st.uncommitted and #st.uncommitted > 0 then
    return nil, "The agent hasn't committed " .. #st.uncommitted .. " file(s) yet; ask it to commit, then apply"
  end
  local lines = { "Branch " .. tostring(st.branch) .. ": " .. #files .. " file(s) changed",
    "Applying moves your " .. (st.base or "branch") .. " branch to the agent's commits." }
  for i = 1, math.min(#files, 10) do lines[#lines + 1] = "  " .. files[i] end
  if #files > 10 then lines[#lines + 1] = "  ..." end
  lines[#lines + 1] = st.needsBuild and "C++ changed: Aseprite will be rebuilt, then restarted."
    or "Only scripts changed: Aseprite will restart."
  -- "&&" is a literal "&" in an alert button ("&" marks the mnemonic).
  return { id = "apply", title = "Apply the agent's changes", text = lines,
    buttons = { st.needsBuild and "Rebuild && Relaunch" or "Relaunch", "Cancel" }, status = st }
end

-- Discard the agent's Developer-mode work (#28).
function Prompter.discardQuestion()
  return { id = "discard", title = "Discard the agent's changes", text = {
    "The agent's worktree is removed; its uncommitted changes go into a git stash",
    "(git stash pop brings them back) and the commits stay on its dev/ branch.",
    "If you already applied them, your branch goes back to where it was.",
  }, buttons = { "Discard", "Cancel" } }
end

-- Reverting a reply the user edited after (#22).
function Prompter.revertQuestion()
  return { id = "revert", title = "Revert reply",
    text = { "You edited the sprite after this reply.", "Reverting also undoes those edits (they stay redoable)." },
    buttons = { "Revert anyway", "Cancel" } }
end

-- A permission request from the agent (ACP): its options are the buttons.
function Prompter.permissionQuestion(req)
  local labels = {}
  for i, o in ipairs(req.options or {}) do labels[i] = o.name or o.optionId end
  if #labels == 0 then labels = { "OK" } end
  return { id = "permission", title = "AI Agent asks permission",
    text = { "The agent wants to use:", req.text or "a tool" }, buttons = labels, request = req }
end

-- Rewind to before a user message (#93). The buttons map to
-- REWIND_CHOICES by index. info: { text, plan = "undo"|"file"|nil, why, own,
-- at (os.time of the checkpoint), warnings = { ... }, running, busy }.
Prompter.REWIND_CHOICES = { "sprite", "conversation", "both", "branch" }
function Prompter.rewindQuestion(info)
  local text = tostring(info.text or ""):gsub("%s+", " ")
  if #text > 60 then text = text:sub(1, utf8.offset(text, 58) or 58) .. "…" end
  local lines = { "Go back to before: \"" .. text .. "\"" }
  if info.plan == "undo" then
    lines[#lines + 1] = "Restore sprite: back through the undo history (Edit > Redo brings the later work back)."
  elseif info.plan == "file" then
    lines[#lines + 1] = "Restore sprite: the undo history no longer reaches it, so the copy opens as a new tab."
  else
    lines[#lines + 1] = "Restore sprite: not available. " .. tostring(info.why or "")
  end
  if info.plan and not info.own then
    lines[#lines + 1] = "(This message ran no Agent turn: the sprite comes from the next checkpoint after it.)"
  end
  lines[#lines + 1] = "Restore conversation: forgets this message and the replies after it; the text goes back in the box."
  lines[#lines + 1] = "Branch: a new chat with the conversation before it, on a copy of the sprite as it was then."
  for _, w in ipairs(info.warnings or {}) do lines[#lines + 1] = w end
  if info.running then lines[#lines + 1] = "A chat is working on this sprite: stop it before restoring the sprite." end
  if info.busy then lines[#lines + 1] = "This chat is working: stop it before restoring the conversation." end
  return { id = "rewind", title = "Rewind", text = lines,
    buttons = { "Restore sprite", "Restore conversation", "Restore both", "Branch from here", "Cancel" }, info = info }
end

-- A message with only an OK button.
function Prompter.notice(title, text)
  return { id = "notice", title = title, text = text, buttons = { "OK" } }
end

return Prompter
