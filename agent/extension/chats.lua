-- Chats (#89): the chat panel's chats and every decision about them, with no
-- UI. Each open sprite has a list of chats; one chat is on screen (current)
-- and at most one runs a turn (running). A message for any chat waits in
-- that chat's queue while a turn runs; the next turn takes the chat on
-- screen first, then the others by age. The running chat's tool requests
-- wait while its sprite is not the active one (the agent's tools act on the
-- active sprite), and a request that makes another sprite active moves the
-- running chat there.
--
--   local Chats = dofile("chats.lua")
--   local chats = Chats.new{
--     parts = function(chat, first) ... end,   -- gives chat.turns/conv/composer/mood
--     spriteExists = function(id) return bool end,
--   }
--   chats:make(spriteId, first)       -- a new chat for a sprite (nil: no sprite)
--   chats:show(chat) / chats:close(id) / chats:siteChanged(spriteId) / chats:rehome(chat, spriteId)
--   chats:enqueue(chat, r) / chats:nextToSend() / chats:sendNow(i) / chats:removeQueued(i) / chats:stop()
--   chats:start(chat) / chats:finish(chat) / chats:gate(activeSpriteId)
--
-- Fields read by the panel: chats.current, chats.running, chats:list().

local Chats = {}
Chats.__index = Chats

function Chats.new(opts)
  return setmetatable({
    parts = assert(opts.parts, "parts required"),
    spriteExists = assert(opts.spriteExists, "spriteExists required"),
    groups = {},       -- sprite key -> { list = { chat, ... }, current = chat }
    byId = {},
    nextId = 0,
    current = nil,     -- the chat on screen
    running = nil,     -- the chat whose turn runs
  }, Chats)
end

function Chats.keyOf(spriteId) return spriteId and ("s" .. spriteId) or "none" end

-- A new chat for a sprite (spriteId nil: no sprite open). `first` marks the
-- panel's first chat, which takes the panel's existing Turns and Composer.
function Chats:make(spriteId, first)
  self.nextId = self.nextId + 1
  local key = Chats.keyOf(spriteId)
  local chat = { id = "c" .. self.nextId, key = key, spriteId = spriteId, queue = {}, queuePaused = false, draft = "" }
  self.parts(chat, first)
  self.byId[chat.id] = chat
  local group = self.groups[key] or { list = {} }
  self.groups[key] = group
  group.list[#group.list + 1] = chat
  group.current = group.current or chat
  if not self.current then self.current = chat end
  return chat
end

function Chats:get(id) return self.byId[id] end

-- The chats of the sprite on screen.
function Chats:list()
  local group = self.current and self.groups[self.current.key]
  return group and group.list or {}
end

-- Puts a chat on screen; it becomes its sprite's chosen chat.
function Chats:show(chat)
  self.current = chat
  local group = self.groups[chat.key]
  if group then group.current = chat end
  return chat
end

local function remove(list, chat)
  for i, c in ipairs(list) do if c == chat then table.remove(list, i); return true end end
  return false
end

-- Closes a chat (not the running one). A sprite's last chat is replaced by
-- an empty one. Returns ok, why and the chat to show when it was on screen.
function Chats:close(id)
  local chat = self.byId[id]
  if not chat then return false, "No such chat" end
  if chat == self.running then return false, "Stop this chat's turn before closing it" end
  local group = self.groups[chat.key]
  remove(group.list, chat)
  self.byId[id] = nil
  if #group.list == 0 then self:make(chat.spriteId) end
  if group.current == chat then group.current = group.list[#group.list] end
  if self.current == chat then return true, nil, self:show(group.current) end
  return true
end

-- The active sprite changed (tab switch, open, close). Drops the chats of
-- closed sprites (except the running one) and returns the chat to show, or
-- nil when the chat on screen already belongs to that sprite.
function Chats:siteChanged(spriteId)
  for key, group in pairs(self.groups) do
    local first = group.list[1]
    if key ~= "none" and first and not self.spriteExists(first.spriteId) then
      local keep = {}
      for _, c in ipairs(group.list) do
        if c == self.running then keep[#keep + 1] = c else self.byId[c.id] = nil end
      end
      if #keep == 0 then self.groups[key] = nil else group.list, group.current = keep, keep[1] end
    end
  end
  local key = Chats.keyOf(spriteId)
  local cur = self.current
  if cur and cur.key == key and self.byId[cur.id] then return nil end
  local group = self.groups[key]
  if not group then self:make(spriteId); group = self.groups[key] end
  return self:show(group.current)
end

-- Moves a chat to another sprite's chats (the agent opened or made it). An
-- untouched empty chat of that sprite gives way.
function Chats:rehome(chat, spriteId)
  local old = self.groups[chat.key]
  if old then
    remove(old.list, chat)
    if #old.list == 0 then self.groups[chat.key] = nil
    elseif old.current == chat then old.current = old.list[1] end
  end
  chat.key, chat.spriteId = Chats.keyOf(spriteId), spriteId
  local group = self.groups[chat.key] or { list = {} }
  self.groups[chat.key] = group
  for i = #group.list, 1, -1 do
    local c = group.list[i]
    if c ~= chat and #c.conv:entries() == 0 and #c.queue == 0 then table.remove(group.list, i); self.byId[c.id] = nil end
  end
  group.list[#group.list + 1] = chat
  group.current = chat
end

-- Queue -----------------------------------------------------------------

function Chats:enqueue(chat, r)
  r.queued = true
  chat.queue[#chat.queue + 1] = r
end

-- The next message to send when no turn runs: the chat on screen first,
-- then the others by age. Returns chat, r (taken off the queue) or nil.
function Chats:nextToSend()
  if self.running then return nil end
  local pick
  local cur = self.current
  if cur and #cur.queue > 0 and not cur.queuePaused then pick = cur end
  if not pick then
    local ids = {}
    for id in pairs(self.byId) do ids[#ids + 1] = id end
    table.sort(ids, function(a, b) return tonumber(a:sub(2)) < tonumber(b:sub(2)) end)
    for _, id in ipairs(ids) do
      local c = self.byId[id]
      if #c.queue > 0 and not c.queuePaused then pick = c; break end
    end
  end
  if not pick then return nil end
  return pick, table.remove(pick.queue, 1)
end

-- Send now: the chat on screen's queued message `index` goes next. Returns
-- false when there is none; otherwise true and whether a running turn must
-- be stopped first (its end sends it).
function Chats:sendNow(index)
  local q = self.current.queue
  index = index or 1
  local item = q[index]
  if not item then return false end
  table.remove(q, index)
  table.insert(q, 1, item)
  self.current.queuePaused = false
  return true, self.running ~= nil
end

function Chats:removeQueued(index)
  local q = self.current.queue
  if not q[index] then return false end
  table.remove(q, index)
  if #q == 0 then self.current.queuePaused = false end
  return true
end

-- Stop: the running chat (or the one on screen) pauses its queue, so its
-- next message doesn't start on its own.
function Chats:stop()
  local chat = self.running or self.current
  if chat and #chat.queue > 0 then chat.queuePaused = true end
end

-- Turns -----------------------------------------------------------------

function Chats:start(chat) self.running = chat end

-- A chat's turn ended; true when it was the running one.
function Chats:finish(chat)
  if self.running ~= chat then return false end
  self.running = nil
  chat.waiting = false
  return true
end

-- Whether a chat request may run now, given the active sprite: true,
-- "hold" while the running chat's sprite is another one, or an error when
-- that sprite was closed. Also returns whether the waiting state changed.
function Chats:gate(activeSpriteId)
  local chat = self.running
  if not chat or not chat.spriteId then return true, false end
  if not self.spriteExists(chat.spriteId) then return "The sprite this chat works on was closed", false end
  local ok = activeSpriteId == chat.spriteId
  local changed = (chat.waiting or false) ~= not ok
  chat.waiting = not ok
  return ok or "hold", changed
end

return Chats
