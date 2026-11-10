-- Conversation: the chat panel's state, with no UI. It records the user's
-- messages and the bridge's chat events as entries, times each turn and
-- step, matches tool results to tool calls, and keeps each provider's
-- conversation id. The chat panel renders entries(); tests feed events.
--
--   local Conversation = dofile("conversation.lua")
--   local c = Conversation.new{ clock = os.time }
--   c:send("make it blue", "claude")       -- starts a turn
--   local r = c:apply(chatEvent)          -- r.turnEnded, r.status
--
-- Entry shapes (entries are read-only for callers):
--   { kind = "user" | "header" | "text" | "status" | "error", text }
--   { kind = "thought", text, secs }
--   { kind = "tool", text, id, toolKind = "edit"|"read", detail, status = nil|"ok"|"failed", result }
--   { kind = "worked", secs }

local PROVIDER_NAMES = { claude = "Claude", codex = "Codex" }
local MAX_ENTRIES = 400

local Conversation = {}
Conversation.__index = Conversation

function Conversation.new(opts)
  opts = opts or {}
  return setmetatable({
    clock = opts.clock or os.time,
    list = {},
    ids = {},            -- provider -> conversation id
    turnStart = nil,     -- clock() when the running turn started
    lastEvent = nil,     -- clock() of the previous step, for "Thought for Ns"
  }, Conversation)
end

local function push(self, e)
  self.list[#self.list + 1] = e
  if #self.list > MAX_ENTRIES then table.remove(self.list, 1) end
  return e
end

local function sinceLast(self)
  local t = self.clock()
  local s = t - (self.lastEvent or t)
  self.lastEvent = t
  return s
end

local function endTurn(self, text)
  if self.turnStart then push(self, { kind = "worked", secs = self.clock() - self.turnStart }) end
  if text then push(self, { kind = "status", text = text }) end
  self.turnStart = nil
end

function Conversation:entries() return self.list end
function Conversation:isBusy() return self.turnStart ~= nil end
function Conversation:conversationId(provider) return self.ids[provider] end

-- Seconds since the running turn started, or nil.
function Conversation:elapsed()
  return self.turnStart and (self.clock() - self.turnStart) or nil
end

-- Starts a turn: the user's bubble and the provider's header.
function Conversation:send(text, provider)
  push(self, { kind = "user", text = text })
  push(self, { kind = "header", text = PROVIDER_NAMES[provider] or provider })
  self.turnStart = self.clock()
  self.lastEvent = self.turnStart
end

-- Ends the running turn with an error that did not come from the agent
-- (e.g. the bridge could not be reached).
function Conversation:fail(text)
  push(self, { kind = "error", text = text })
  endTurn(self)
end

-- Applies one chat event from the bridge. Returns
--   { turnEnded = bool, status = string|nil }
-- so the caller can update its controls.
function Conversation:apply(ev)
  local t = ev.type
  if t == "session" then
    if ev.provider then self.ids[ev.provider] = ev.sessionId end
  elseif t == "text" then
    sinceLast(self)
    push(self, { kind = "text", text = ev.text or "" })
  elseif t == "thinking" then
    push(self, { kind = "thought", text = ev.text or "", secs = sinceLast(self) })
  elseif t == "tool" then
    sinceLast(self)
    push(self, { kind = "tool", text = ev.tool or "tool", id = ev.id, toolKind = ev.kind, detail = ev.detail })
  elseif t == "tool_result" then
    sinceLast(self)
    for i = #self.list, 1, -1 do
      local e = self.list[i]
      if e.kind == "tool" and e.status == nil and e.id == ev.id then
        e.status = ev.ok and "ok" or "failed"
        e.result = ev.detail
        break
      end
    end
  elseif t == "status" then
    return { turnEnded = false, status = ev.text or "" }
  elseif t == "error" then
    push(self, { kind = "error", text = ev.text or "error" })
    endTurn(self)
    return { turnEnded = true }
  elseif t == "done" then
    endTurn(self, ev.text)
    return { turnEnded = true }
  end
  return { turnEnded = false }
end

-- Forgets the messages and conversation ids (New chat).
function Conversation:reset()
  self.list = {}
  self.ids = {}
  self.turnStart = nil
  self.lastEvent = nil
end

return Conversation
