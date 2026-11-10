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
--   { kind = "worked", secs, check = nil|{ errors, warnings }, applyPlan = nil|true, planApplied = nil|true }
--     (check: the turn's last check, if any; applyPlan: a Plan-mode reply that can be carried out)
--   { kind = "plan", items = { { content, status = "pending"|"in_progress"|"completed" }, ... } }
--   { kind = "variations", task, items = { { name, image }, ... }, prompt, resolved = nil|"Kept v2"|"Discarded" }

local PROVIDER_NAMES = { claude = "Claude", codex = "Codex" }
local MODE_NAMES = { ask = "Ask", plan = "Plan" }   -- Agent mode is not labeled
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

-- The last check result in the running turn: { errors, warnings } or nil.
local function lastCheck(self)
  for i = #self.list, 1, -1 do
    local e = self.list[i]
    if e.kind == "user" then return nil end
    if e.kind == "tool" and e.name == "check" and e.check then return e.check end
  end
end

local function endTurn(self, text, completed)
  if self.turnStart then
    push(self, { kind = "worked", secs = self.clock() - self.turnStart, check = lastCheck(self),
                 applyPlan = (completed and self.turnMode == "plan") or nil })
  end
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

-- Starts a turn: the user's bubble and the provider's header, with the
-- mode when it is not Agent (#24).
function Conversation:send(text, provider, mode)
  push(self, { kind = "user", text = text })
  local name = PROVIDER_NAMES[provider] or provider
  push(self, { kind = "header", text = MODE_NAMES[mode] and (name .. " · " .. MODE_NAMES[mode]) or name, mode = mode })
  self.turnMode = mode
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
    -- ACP agents refine a step as its input streams in: same id, newer label.
    for i = #self.list, 1, -1 do
      local e = self.list[i]
      if e.kind == "user" then break end
      if e.kind == "tool" and ev.id and e.id == ev.id then
        e.text, e.detail = ev.tool or e.text, ev.detail or e.detail
        e.name, e.toolKind = ev.name or e.name, ev.kind or e.toolKind
        return { turnEnded = false }
      end
    end
    sinceLast(self)
    push(self, { kind = "tool", text = ev.tool or "tool", name = ev.name, id = ev.id, toolKind = ev.kind, detail = ev.detail })
  elseif t == "plan" then
    -- One plan per turn, updated in place as the agent works through it.
    local items = {}
    for _, it in ipairs(ev.entries or {}) do items[#items + 1] = { content = it.content, status = it.status } end
    for i = #self.list, 1, -1 do
      local e = self.list[i]
      if e.kind == "user" then break end
      if e.kind == "plan" then e.items = items; return { turnEnded = false } end
    end
    push(self, { kind = "plan", items = items })
  elseif t == "permission" then
    -- The panel asks the user; the answer is recorded with recordPermission.
    return { turnEnded = false, permission = ev }
  elseif t == "tool_result" then
    sinceLast(self)
    for i = #self.list, 1, -1 do
      local e = self.list[i]
      if e.kind == "tool" and e.status == nil and e.id == ev.id then
        e.status = ev.ok and "ok" or "failed"
        e.result = ev.detail
        if e.name == "check" and ev.ok and ev.detail then
          local errors, warnings = tostring(ev.detail):match("Check: (%d+) errors?, (%d+) warnings?")
          if errors then e.check = { errors = tonumber(errors), warnings = tonumber(warnings) } end
        end
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
    -- A turn that ends with a note (Stopped., stopped early) did not finish.
    endTurn(self, ev.text, ev.text == nil)
    return { turnEnded = true }
  end
  return { turnEnded = false }
end

-- Adds a plain entry ("user", "status" or "error") outside an agent turn,
-- e.g. a saved command run from the chat (#26).
function Conversation:note(kind, text)
  return push(self, { kind = kind, text = text })
end

-- Variations the agent built for a task (#25), with the user's request that
-- led to them (stored on the layer the user keeps).
function Conversation:addVariations(task, items)
  local prompt
  for i = #self.list, 1, -1 do
    if self.list[i].kind == "user" then prompt = self.list[i].text; break end
  end
  return push(self, { kind = "variations", task = task, items = items, prompt = prompt })
end

-- Records the user's answer to a permission request.
function Conversation:recordPermission(title, answer)
  push(self, { kind = "status", text = string.format("Permission for %s: %s", title or "a tool", answer) })
end

-- Forgets the messages and conversation ids (New chat).
function Conversation:reset()
  self.list = {}
  self.ids = {}
  self.turnStart = nil
  self.lastEvent = nil
end

---------------------------------------------------------------------------
-- Mentions and links (#20); pure text helpers, no app access.
---------------------------------------------------------------------------

-- "@[Body]" tokens in the user's text -> "Body (aseprite://layer/L2)", using
-- the label -> URI map the picker filled. Unknown tokens stay as typed.
function Conversation.expandMentions(text, mentions)
  return (text:gsub("@%[(.-)%]", function(label)
    local uri = mentions and mentions[label]
    return uri and (label .. " (" .. uri .. ")") or nil
  end))
end

-- Markdown links to aseprite:// URIs in a reply -> plain display text plus
-- link spans { label, uri, from, to } (byte offsets in the display text).
-- Other markdown links are left as written.
function Conversation.parseLinks(text)
  local out, links, pos = {}, {}, 1
  local len = 0
  while true do
    local s, e, label, uri = text:find("%[([^%]]-)%]%((aseprite://[^%)%s]+)%)", pos)
    if not s then break end
    local before = text:sub(pos, s - 1)
    out[#out + 1] = before
    len = len + #before
    links[#links + 1] = { label = label, uri = uri, from = len + 1, to = len + #label }
    out[#out + 1] = label
    len = len + #label
    pos = e + 1
  end
  out[#out + 1] = text:sub(pos)
  return table.concat(out), links
end

return Conversation
