-- Composer: the chat panel's draft, with no UI. It keeps what the user is
-- composing (prompt text, @ mentions, pending Attachments, the skill chip,
-- the / picker's matches) and decides what Enter does with it. The Chat
-- Panel is its adapter: it reads the textedit, asks the Composer, and
-- carries out the outcome (dialogs, tips, chat.send).
--
--   local C = Composer.new{
--     commands = function() return savedCommandsList end,   -- Saved Commands (reloaded per call)
--     selectionEmpty = function() return bool end,          -- no sprite, or nothing selected
--     stateBlock = function() return text end,               -- the State block
--     changes = function() return text or nil end,           -- changes since the last reply
--     expandMentions = Conversation.expandMentions,
--   }
--   C:setCatalog(rows)    -- Skill Catalog rows: { name, title, source, description, category, needs }
--
-- Outcomes of C:decide{ text, provider, mode, developerConfirmed }:
--   { kind = "none" }                                     nothing to do
--   { kind = "tip", message = "..." }                     tell the user, keep the draft
--   { kind = "command", name, args, text }                run Saved Command /name with args (raw text)
--   { kind = "pick", item, text, tips }                   a / picker match was picked; text is the new prompt
--   { kind = "confirm_developer" }                        ask once, then decide again with developerConfirmed
--   { kind = "send", payload, shown, skillTitle }         payload = { prompt, state, changes, provider, mode,
--                                                         attachments }; shown is the user's bubble text
-- "command", "pick" and "send" consume what they use of the draft.

local Composer = {}
Composer.__index = Composer

local MAX_ATTACHMENTS = 8

function Composer.new(opts)
  opts = opts or {}
  local self = setmetatable({}, Composer)
  self.commands = opts.commands or function() return {} end
  self.selectionEmpty = opts.selectionEmpty or function() return true end
  self.stateBlock = opts.stateBlock or function() return nil end
  self.changes = opts.changes or function() return nil end
  self.expandMentions = opts.expandMentions or function(text) return text end
  self.catalog = {}
  self.text = ""          -- the prompt as last seen (to tell typing "@" from pasting)
  self.mentions = {}      -- @[label] -> aseprite:// URI for the draft being typed
  self.pending = {}       -- Attachments for the next message
  self.imageSent = false  -- this conversation already has an image (skills that need one)
  self.picked = nil       -- the skill chip (a catalog row)
  self.suggest = nil      -- { items, index }: the / picker
  return self
end

---------------------------------------------------------------------------
-- Skill Catalog and the / picker
---------------------------------------------------------------------------

function Composer:setCatalog(rows) self.catalog = rows or {} end
function Composer:hasCatalog() return #self.catalog > 0 end

function Composer:skillByName(name)
  for _, s in ipairs(self.catalog) do if s.name == name then return s end end
end

-- Skills (not guide topics) and enabled Saved Commands that contain every
-- typed word, best matches first. A bare "/" lists everything grouped by
-- category, your commands last.
function Composer:matches(query)
  local items = {}
  for _, s in ipairs(self.catalog) do
    if s.source ~= "guide" then items[#items + 1] = s end
  end
  for _, c in ipairs(self.commands() or {}) do
    if c.enabled ~= false then
      items[#items + 1] = { kind = "command", name = c.name, title = c.title, description = c.description, source = "command" }
    end
  end
  local words = {}
  for w in (query or ""):lower():gmatch("%S+") do words[#words + 1] = w end
  local out = {}
  for _, it in ipairs(items) do
    local head = (it.name .. " " .. it.title):lower()
    local all = head .. " " .. (it.description or ""):lower() .. " " .. (it.category or ""):lower()
    local score, ok = 0, true
    for _, w in ipairs(words) do
      if not all:find(w, 1, true) then ok = false; break end
      score = score + (head:sub(1, #w) == w and 3 or (head:find(w, 1, true) and 2 or 1))
    end
    if ok then out[#out + 1] = { it = it, score = score } end
  end
  local function group(it) return it.kind == "command" and "~" or (it.category or "Other") end
  table.sort(out, function(a, b)
    if #words == 0 and group(a.it) ~= group(b.it) then return group(a.it) < group(b.it) end
    if a.score ~= b.score then return a.score > b.score end
    return a.it.title < b.it.title
  end)
  local list = {}
  for _, o in ipairs(out) do list[#list + 1] = o.it end
  return list
end

function Composer:setSuggestions(items) self.suggest = items and { items = items, index = 1 } or nil end
function Composer:suggestions() return self.suggest and self.suggest.items or {} end
function Composer:suggestionIndex() return self.suggest and self.suggest.index or 0 end
function Composer:pickerOpen() return self.suggest ~= nil and #self.suggest.items > 0 end

function Composer:pickedSkill() return self.picked end
function Composer:clearPickedSkill() self.picked = nil end

-- Picking a match: a skill becomes the chip (the prompt keeps only the
-- request), a Saved Command "/name ". Returns { item, text, tips }.
function Composer:pick(item)
  if not item then return nil end
  if item.kind == "command" then
    self.text = "/" .. item.name .. " "
  else
    self.picked = item
    self.text = ""
  end
  self.suggest = nil
  local tips = {}
  for _, n in ipairs(item.needs or {}) do
    if n == "image" and #self.pending == 0 then tips[#tips + 1] = "This skill needs an image: attach one with +" end
    if n == "selection" and self.selectionEmpty() then tips[#tips + 1] = "This skill works on a selection: select an area first" end
  end
  return { kind = "pick", item = item, text = self.text, tips = tips }
end

-- A key in the prompt. Returns nil when the key isn't used here, else what
-- happened: { kind = "move", index } | the pick outcome | { kind = "close" }
-- | { kind = "chip_removed" }. With the picker open, Up/Down move the
-- highlight (wrapping), Enter or Tab picks, Escape closes; Backspace in an
-- empty prompt removes the skill chip.
function Composer:onKey(code, text)
  if self:pickerOpen() then
    local s = self.suggest
    local n = #s.items
    if code == "ArrowDown" then s.index = s.index % n + 1; return { kind = "move", index = s.index }
    elseif code == "ArrowUp" then s.index = (s.index - 2) % n + 1; return { kind = "move", index = s.index }
    elseif code == "Enter" or code == "NumpadEnter" or code == "Tab" then return self:pick(s.items[s.index])
    elseif code == "Escape" then self.suggest = nil; return { kind = "close" }
    end
    return nil
  end
  if code == "Backspace" and self.picked and (text or self.text) == "" then
    self.picked = nil
    return { kind = "chip_removed" }
  end
  return nil
end

-- The prompt changed (typing). Returns { mentionPicker, needCatalog,
-- suggestChanged }: typing "@" at the end opens the mention picker; a
-- prompt that is just "/query" shows matching skills and commands.
function Composer:onTextChange(text)
  text = text or ""
  local grew = #text == #self.text + 1 and text:sub(1, #self.text) == self.text
  self.text = text
  local r = { mentionPicker = grew and text:sub(-1) == "@", needCatalog = false, suggestChanged = false }
  local query = text:match("^/([^%s]*)$")
  if query and not query:match("^skill:") then
    r.needCatalog = #self.catalog == 0
    self:setSuggestions(self:matches((query:gsub("[-_]", " "))))
    r.suggestChanged = true
  elseif self.suggest then
    self.suggest = nil
    r.suggestChanged = true
  end
  return r
end

-- The prompt was set from outside (scripts, tests), not typed.
function Composer:setText(text) self.text = text or "" end

-- A mention token for a picker choice, replacing a typed "@". Returns the new prompt.
function Composer:insertMention(target, text)
  text = text or ""
  if text:sub(-1) == "@" then text = text:sub(1, -2) end
  local sep = (text == "" or text:match("%s$")) and "" or " "
  self.mentions[target.name] = target.uri
  self.text = text .. sep .. "@[" .. target.name .. "] "
  return self.text
end

---------------------------------------------------------------------------
-- Attachments
---------------------------------------------------------------------------

function Composer:addAttachment(a)
  if #self.pending >= MAX_ATTACHMENTS then return false, "At most 8 attachments per message" end
  self.pending[#self.pending + 1] = a
  return true
end
function Composer:clearAttachments() self.pending = {} end
function Composer:pendingAttachments()
  local out = {}
  for _, a in ipairs(self.pending) do out[#out + 1] = { label = a.label, path = a.path, uri = a.uri } end
  return out
end
function Composer:attachmentLabels()
  local names = {}
  for _, a in ipairs(self.pending) do names[#names + 1] = a.label end
  return names
end

-- New chat: the next conversation has no image yet.
function Composer:newConversation() self.imageSent = false end

---------------------------------------------------------------------------
-- What Enter does
---------------------------------------------------------------------------

-- ctx: { text, provider, mode, developerConfirmed }.
function Composer:decide(ctx)
  local prompt = ctx.text or ""
  if prompt:match("^%s*$") then
    if self.picked then return { kind = "tip", message = "Write what you want " .. self.picked.title .. " to do" } end
    return { kind = "none" }
  end
  -- A Saved Command's exact name runs it, even while the picker shows it.
  local name, rest = prompt:match("^%s*/([%w%-]+)%s*(.-)%s*$")
  if name then
    for _, c in ipairs(self.commands() or {}) do
      if c.name == name then
        self.text = ""
        self.suggest = nil
        return { kind = "command", name = name, args = rest, text = prompt }
      end
    end
  end
  -- Enter on any other bare "/query" picks the best match instead of sending.
  if self:pickerOpen() and prompt:match("^/[^%s]*$") then
    return self:pick(self.suggest.items[self.suggest.index])
  end
  self.suggest = nil
  -- The skill chip goes with the message as /skill:name.
  if self.picked and not prompt:match("^%s*/skill:") then prompt = "/skill:" .. self.picked.name .. " " .. prompt end
  -- A skill that needs an image waits for an attachment (#35).
  local skillName = prompt:match("^%s*/skill:([%w%-_]+)")
  local skill = skillName and self:skillByName(skillName)
  if skill then
    for _, n in ipairs(skill.needs or {}) do
      -- A follow-up in a conversation that already has the image is fine.
      if n == "image" and #self.pending == 0 and not self.imageSent then
        return { kind = "tip", message = skill.title .. " needs an image: attach one with + first" }
      end
      if n == "selection" and self.selectionEmpty() then
        return { kind = "tip", message = skill.title .. " works on a selection: select an area first" }
      end
    end
  end
  if ctx.mode == "developer" and not ctx.developerConfirmed then return { kind = "confirm_developer" } end

  -- The document's state goes with every message (#18), and what changed
  -- since the agent's last reply (#19), if anything.
  local state = self.stateBlock()
  local changes = self.changes()
  -- @[label] tokens become "label (aseprite://...)" for the agent (#20).
  local expanded = self.expandMentions(prompt, self.mentions)
  -- Attached images go as image blocks; the bridge adds a line for each.
  local attachments, shown = {}, prompt
  for _, a in ipairs(self.pending) do
    attachments[#attachments + 1] = { label = a.label, path = a.path, uri = a.uri }
    shown = shown .. "\nAttached: " .. a.label
  end
  if #self.pending > 0 then self.imageSent = true end
  -- The header names the skill, so the bubble shows only the request.
  if skill then shown = shown:gsub("^%s*/skill:[%w%-_]+%s*", "", 1) end

  self.mentions = {}
  self.pending = {}
  self.picked = nil   -- the chip goes with this message
  self.text = ""
  return {
    kind = "send",
    payload = { prompt = expanded, state = state, changes = changes, provider = ctx.provider, mode = ctx.mode,
                attachments = #attachments > 0 and attachments or nil },
    shown = shown,
    -- Before the catalog arrives (right after start), name the skill by its id.
    skillTitle = skill and skill.title or skillName,
  }
end

return Composer
