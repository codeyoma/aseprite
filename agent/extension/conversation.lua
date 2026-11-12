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
--   { kind = "user" | "header" | "text" | "status" | "error", text }   (a user entry may have images = { { label, path } })
--   { kind = "thought", text, secs }
--   { kind = "tool", text, id, toolKind = "edit"|"read", detail, status = nil|"ok"|"failed", result }
--   { kind = "worked", secs, check = nil|{ errors, warnings }, applyPlan = nil|true, planApplied = nil|true }
--     (check: the turn's last check, if any; applyPlan: a Plan-mode reply that can be carried out)
--   { kind = "plan", items = { { content, status = "pending"|"in_progress"|"completed" }, ... } }
--   { kind = "question", text, options = { "label", ... }, answered = nil|"label" }   (ask_user)
--   { kind = "variations", task, items = { { name, image }, ... }, prompt, resolved = nil|"Kept v2"|"Discarded" }
--   { kind = "memory", topic, text, answered = nil|"Remember"|"Don't remember" }   (remember_style, #93)
-- A user entry that started an Agent turn carries checkpoint = { path, undoId, spriteId, ... } (#93).
--
-- Rewind (#93): truncateAt(userEntry) drops that message and everything after
-- it and forgets the provider conversation ids; the kept messages become a
-- recap (recapToSend) that goes with the next message until the agent starts
-- its new conversation. branchData(userEntry) is the same cut as data for a
-- new chat.

local PROVIDER_NAMES = { claude = "Claude", codex = "Codex" }
local MODE_NAMES = { ask = "Ask", plan = "Plan", developer = "Developer" }   -- Agent mode is not labeled
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
                 applyPlan = (completed and self.turnMode == "plan") or nil,
                 devActions = (self.turnMode == "developer") or nil })
  end
  if text then push(self, { kind = "status", text = text }) end
  self.turnStart = nil
end

function Conversation:entries() return self.list end
function Conversation:isBusy() return self.turnStart ~= nil end
function Conversation:conversationId(provider) return self.ids[provider] end
-- Every conversation id by key, for the bridge to pick from (#55).
function Conversation:conversationIds()
  local out = {}
  for k, v in pairs(self.ids) do out[k] = v end
  return out
end

-- Seconds since the running turn started, or nil.
function Conversation:elapsed()
  return self.turnStart and (self.clock() - self.turnStart) or nil
end

-- Starts a turn: the user's bubble and the provider's header, with the
-- mode when it is not Agent (#24).
-- skill: the title of the skill the message runs with (#35), shown too.
-- images: the attached images, { { label, path }, ... } (shown as cards under the bubble).
function Conversation:send(text, provider, mode, skill, images)
  local list
  if images and #images > 0 then
    list = {}
    for _, im in ipairs(images) do list[#list + 1] = { label = tostring(im.label or ""), path = im.path and tostring(im.path) or nil } end
  end
  push(self, { kind = "user", text = text, images = list })
  local name = PROVIDER_NAMES[provider] or provider
  if MODE_NAMES[mode] then name = name .. " · " .. MODE_NAMES[mode] end
  if skill then name = name .. " · " .. skill end
  push(self, { kind = "header", text = name, mode = mode, skill = skill })
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
  -- Sub-agents (#33): their steps carry a scope label; their replies are
  -- notes under the lead agent's turn, not replies of their own.
  if ev.agent then
    if t == "text" then
      push(self, { kind = "status", text = "[" .. ev.agent .. "] " .. (ev.text or "") })
      return { turnEnded = false }
    elseif t == "tool" then
      ev = { type = "tool", id = ev.id, tool = "[" .. ev.agent .. "] " .. (ev.tool or "tool"), name = ev.name, kind = ev.kind,
             detail = ev.detail }
    elseif t == "thinking" then
      return { turnEnded = false }
    end
  end
  if t == "session" then
    if ev.provider then self.ids[ev.provider] = ev.sessionId end
    -- The agent has its new conversation, with the recap in it.
    self.needsRecap = nil
  elseif t == "memory" then
    -- remember_style (#93): a proposed style memory entry; the user approves it with a button.
    sinceLast(self)
    push(self, { kind = "memory", topic = tostring(ev.topic or "note"), text = ev.text or "" })
  elseif t == "question" then
    -- ask_user: a question with option buttons; the answer is the user's next message.
    sinceLast(self)
    local options = {}
    for _, o in ipairs(ev.choices or {}) do options[#options + 1] = tostring(o) end
    push(self, { kind = "question", text = ev.text or "", options = options })
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
  elseif t == "build" then
    -- Developer mode (#28): the result of Rebuild & Relaunch.
    push(self, { kind = ev.ok and "status" or "error",
                 text = ev.ok and "Build succeeded." or ("Build failed:\n" .. (ev.text or "")) })
    return { turnEnded = false, build = ev }
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

-- Plain data for saving across an Aseprite restart (Developer mode
-- relaunch). Images (step captures, variations) are left out.
local SAVED = { user = true, header = true, text = true, status = true, error = true, thought = true,
                tool = true, worked = true, plan = true }
function Conversation:serialize()
  local list = {}
  for _, e in ipairs(self.list) do
    if SAVED[e.kind] then
      list[#list + 1] = { kind = e.kind, text = e.text, secs = e.secs, id = e.id, name = e.name, toolKind = e.toolKind,
        detail = e.detail, status = e.status, result = e.result, check = e.check, items = e.items, mode = e.mode, images = e.images,
        checkpoint = e.checkpoint }
    end
  end
  local ids = {}
  for k, v in pairs(self.ids) do ids[k] = v end
  return { entries = list, ids = ids, carried = self.carried, needsRecap = self.needsRecap }
end

local FIELDS = { "kind", "text", "secs", "id", "name", "toolKind", "detail", "status", "result", "mode" }
local CHECKPOINT_FIELDS = { "path", "undoId", "spriteId", "key", "at", "turnSeq", "title", "source" }

-- Accepts plain tables or the JSON objects json.decode returns (copied
-- into plain tables, so the panel can annotate entries).
function Conversation:restore(data)
  self.list, self.ids = {}, {}
  for _, src in ipairs(data.entries or {}) do
    local e = {}
    for _, f in ipairs(FIELDS) do e[f] = src[f] end
    if src.check then e.check = { errors = src.check.errors, warnings = src.check.warnings } end
    if src.images then
      e.images = {}
      for _, im in ipairs(src.images) do e.images[#e.images + 1] = { label = im.label, path = im.path } end
    end
    if src.items then
      e.items = {}
      for _, it in ipairs(src.items) do e.items[#e.items + 1] = { content = it.content, status = it.status } end
    end
    if src.checkpoint ~= nil and type(src.checkpoint) ~= "string" then
      e.checkpoint = {}
      for _, f in ipairs(CHECKPOINT_FIELDS) do e.checkpoint[f] = src.checkpoint[f] end
    end
    self.list[#self.list + 1] = e
  end
  -- Conversation keys belong to the bridge; keep every one.
  for k, v in pairs(data.ids or {}) do
    if type(k) == "string" and type(v) == "string" then self.ids[k] = v end
  end
  self.carried = type(data.carried) == "string" and data.carried or nil
  self.needsRecap = data.needsRecap == true or nil
  self.turnStart = nil
end

-- Forgets the messages and conversation ids (New chat).
function Conversation:reset()
  self.list = {}
  self.ids = {}
  self.carried, self.needsRecap = nil, nil
  self.turnStart = nil
  self.lastEvent = nil
end

---------------------------------------------------------------------------
-- Rewind (#93): restore the conversation to before a message, or branch
---------------------------------------------------------------------------

-- The position of an entry in the list, or nil.
function Conversation:indexOf(entry)
  for i, e in ipairs(self.list) do if e == entry then return i end end
  return nil
end

-- The newest user entry (the message of the running or last turn).
function Conversation:lastUser()
  for i = #self.list, 1, -1 do if self.list[i].kind == "user" then return self.list[i] end end
end

local RECAP_TEXT = 1200   -- longest reply or message kept whole in a recap

local function short(text, max)
  text = tostring(text or ""):gsub("[ \t\r\n\f\v]+$", "")   -- ASCII: %s takes a UTF-8 byte on Windows
  if #text <= max then return text end
  local cut = utf8.offset(text, max) or max
  return text:sub(1, cut - 1) .. " [...]"
end

-- The entries before position `upto` (all when nil) as a recap: who said
-- what, the agent's steps as one line per turn, no thoughts or tool output.
-- What a branch carried over from its parent chat beyond the copied entries
-- (`carried`) comes first.
function Conversation:recapText(upto)
  local out = {}
  if self.carried and self.carried ~= "" then out[#out + 1] = self.carried end
  local steps = {}
  local function flushSteps()
    if #steps > 0 then out[#out + 1] = "Agent steps: " .. table.concat(steps, "; ") end
    steps = {}
  end
  local last = (upto or (#self.list + 1)) - 1
  for i = 1, last do
    local e = self.list[i]
    if e.kind == "user" then
      flushSteps()
      local images = (e.images and #e.images > 0) and string.format(" [%d image%s attached]", #e.images, #e.images == 1 and "" or "s") or ""
      out[#out + 1] = "User: " .. short(e.text, RECAP_TEXT) .. images
    elseif e.kind == "tool" then
      steps[#steps + 1] = tostring(e.text or e.name or "tool") .. (e.status == "failed" and " (failed)" or "")
    elseif e.kind == "text" then
      flushSteps()
      out[#out + 1] = "Agent: " .. short(e.text, RECAP_TEXT)
    elseif e.kind == "question" then
      flushSteps()
      out[#out + 1] = "Agent asked: " .. short(e.text, 300) .. (e.answered and (" (user picked: " .. e.answered .. ")") or "")
    elseif e.kind == "memory" and e.answered then
      out[#out + 1] = string.format("Style memory proposal (%s: %s): %s", e.topic or "note", short(e.text, 300), e.answered)
    elseif e.kind == "error" then
      flushSteps()
      out[#out + 1] = "Error: " .. short(e.text, 300)
    end
  end
  flushSteps()
  return table.concat(out, "\n")
end

-- The recap to send with the message of the turn being started (the newest
-- user entry), or nil. Needed after truncateAt or a branch, until the agent
-- reports its new conversation.
function Conversation:recapToSend()
  if not self.needsRecap then return nil end
  local last = self:lastUser()
  local text = self:recapText(last and self:indexOf(last) or nil)
  return text ~= "" and text or nil
end

-- Restores the conversation to just before the user message `entry`: that
-- message and everything after it go, the provider conversation ids are
-- forgotten, and the kept messages go as a recap with the next message.
-- Returns the removed message's text, or nil and why.
function Conversation:truncateAt(entry)
  if self:isBusy() then return nil, "Stop this chat's turn first" end
  local i = self:indexOf(entry)
  if not i or entry.kind ~= "user" then return nil, "Not a message of this chat" end
  for j = #self.list, i, -1 do self.list[j] = nil end
  self.ids = {}
  self.needsRecap = true
  self.lastEvent = nil
  return entry.text or ""
end

-- Data for a new chat that branches from just before the user message
-- `entry`: the earlier entries (as serialize() makes them), no conversation
-- ids, and a recap to send first. Returns data, the message text; or nil and why.
function Conversation:branchData(entry)
  local i = self:indexOf(entry)
  if not i or entry.kind ~= "user" then return nil, "Not a message of this chat" end
  local all = self:serialize()
  local kept, n = {}, 0
  for j = 1, i - 1 do
    local e = self.list[j]
    if SAVED[e.kind] then n = n + 1; kept[n] = all.entries[n] end
  end
  return { entries = kept, ids = {}, carried = self.carried, needsRecap = true }, entry.text or ""
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
