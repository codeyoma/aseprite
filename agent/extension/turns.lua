-- Turns: the Turn controller. One agent reply from the message that starts
-- it to the event that ends it, over the Conversation (entries, timings)
-- and Turn History (where the reply sits in the undo history). It claims
-- the Step Captures of each edit step, finishes the turn when the agent is
-- done or fails, reverts and restores a whole reply (#22), and says what
-- changed since the last reply (#19). No UI: the Chat Panel calls it and
-- redraws; tests drive it with events and a fake Turn History and capture.
--
--   local Turns = dofile("turns.lua")
--   local turns = Turns.new{ Conversation = dofile("conversation.lua"), clock = os.time,
--                            history = dofile("turn_history.lua"), capture = capture,
--                            sprite = function() return app.sprite end }
--   turns:start(app.sprite, { text, provider, mode, skill })  -- -> turn record
--   local r = turns:apply(chatEvent)        -- Conversation:apply's result
--   turns:fail("Could not reach the bridge")
--   turns:changesSince()                    -- text for the next message, or nil
--   turns:action(header, "revert"|"restore", force)  -- ok, why, needsForce
--   turns:view(header)                      -- status, "revert"|"restore"|nil
--
-- A turn is named by its header entry (the "● Claude" row); nil means the
-- last finished turn.

local Turns = {}
Turns.__index = Turns

-- deps:
--   conversation  a Conversation, or Conversation (the module) and clock to make one
--   history       Turn History (turn_history.lua) or a fake with the same functions
--   capture       Step Capture (optional): seq(), claim(sinceSeq)
--   sprite        function returning the active sprite (default app.sprite)
function Turns.new(deps)
  local conv = deps.conversation or deps.Conversation.new{ clock = deps.clock or os.time }
  return setmetatable({
    conversation = conv,
    history = assert(deps.history, "history required: turn_history.lua"),
    capture = deps.capture,
    activeSprite = deps.sprite or function() return app.sprite end,
    byHeader = setmetatable({}, { __mode = "k" }),   -- header entry -> turn record
    current = nil,    -- the running turn's record
    last = nil,       -- the last finished turn, for "changes since your last reply"
  }, Turns)
end

function Turns:isBusy() return self.conversation:isBusy() end
function Turns:currentTurn() return self.current end
function Turns:lastTurn() return self.last end

-- Starts a reply: the user's message and the header in the Conversation
-- (when message is given), and where the reply starts in the undo history.
-- message: { text, provider, mode, skill }.
function Turns:start(sprite, message)
  if message then
    self.conversation:send(message.text, message.provider, message.mode, message.skill)
  end
  local list = self.conversation:entries()
  local header = list[#list]
  local turn = self.history.begin(sprite)
  -- Captures after this one belong to this reply.
  turn.captureSeq = self.capture and self.capture:seq() or 0
  self.current = turn
  if header and header.kind == "header" then self.byHeader[header] = turn end
  return turn
end

local function finish(self)
  if not self.current then return end
  self.history.finish(self.current, self.activeSprite())
  self.last, self.current = self.current, nil
end

-- The tool entry of the running turn with this id.
local function toolEntry(self, id)
  local list = self.conversation:entries()
  for i = #list, 1, -1 do
    local e = list[i]
    if e.kind == "tool" and e.id == id then return e end
  end
end

-- Applies a chat event. A successful edit step claims the captures since
-- the turn started (#23); "done" and "error" finish the turn.
-- Returns Conversation:apply's result ({ turnEnded, status, permission, build }).
function Turns:apply(ev)
  local r = self.conversation:apply(ev)
  if ev.type == "tool_result" and ev.ok and self.capture and self.current then
    local e = toolEntry(self, ev.id)
    if e and e.toolKind == "edit" and not e.capture then
      e.capture = self.capture:claim(self.current.captureSeq)
    end
  end
  if r.turnEnded then finish(self) end
  return r
end

-- Ends the running turn with an error that did not come from the agent.
function Turns:fail(text)
  self.conversation:fail(text)
  finish(self)
end

-- What changed since the agent's last reply, when it was on the active sprite.
function Turns:changesSince()
  local t = self.last
  if t and t.sprite ~= nil and t.sprite == self.activeSprite() then
    return self.history.changesSince(t)
  end
  return nil
end

local function turnFor(self, header)
  if header == nil then return self.last end
  return self.byHeader[header]
end

-- A finished reply's status ("done", "undone", "partly undone", "empty",
-- "gone") and the action its button offers ("revert", "restore" or nil).
-- nil while the reply runs, or for an entry that is not a reply's header.
function Turns:view(header)
  local turn = turnFor(self, header)
  if not (turn and turn.finish) then return nil end
  local H = self.history
  local status = H.status(turn)
  local action
  if status == "done" or status == "partly undone" then
    if H.canRevert(turn) then action = "revert" end
  elseif status == "undone" then
    action = "restore"
  end
  return status, action
end

-- Reverts or restores a whole reply. Returns ok, why and, when a revert is
-- refused only because the user edited after the reply, needsForce = true:
-- ask the user, then call again with force (those edits stay redoable).
function Turns:action(header, name, force)
  local turn = turnFor(self, header)
  if not turn then return false, "No reply to " .. name end
  local H = self.history
  if name == "restore" then return H.restore(turn) end
  if name ~= "revert" then return false, "Unknown action " .. tostring(name) end
  local ok, why = H.revert(turn, force)
  if not ok and not force and H.canRevert(turn) and H.hasLaterEdits(turn) then
    return false, why, true
  end
  return ok, why
end

return Turns
