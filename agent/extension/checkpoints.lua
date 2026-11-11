-- Checkpoints (#93): a copy of a chat's sprite taken when a message starts
-- an Agent or Developer turn, so the user can go back to the moment before
-- that message (restore the sprite, the conversation, both, or branch from
-- there, like Claude Code's /rewind). Each checkpoint is an .aseprite file in
-- a per-sprite folder under the agent home, plus the sprite's undo state id
-- at that moment. File access comes in as functions (agent.lua), so this
-- module only keeps the books and is tested with fakes.
--
--   local Checkpoints = dofile("checkpoints.lua")
--   local cp = Checkpoints.new{ dir = home .. "/checkpoints", keep = 20,
--     save = function(sprite, path) sprite:saveCopyAs(path) end,   -- in agent.lua
--     remove = os.remove, makeDirs = app.fs.makeAllDirectories,
--     listFiles = app.fs.listFiles, isFile = app.fs.isFile, clock = os.time }
--   local rec = cp:take(sprite)          -- { path, undoId, spriteId, key, turnSeq, at } or nil, why
--   cp:noteTurn(spriteId, chatId)        -- a turn started on that sprite
--   cp:othersAfter(rec, chatId)          -- other chats that ran turns on the sprite since
--   cp:restorePlan(rec, sprite)          -- "undo" | "file" | nil, why
--
-- Restoring prefers the undo history (sprite:undoTo(rec.undoId): exact, and
-- Redo brings the later work back) and otherwise opens the file as a new tab,
-- never a partial rebuild over the user's sprite.

local Checkpoints = {}
Checkpoints.__index = Checkpoints

Checkpoints.KEEP = 20

-- A short stable hash of a string (djb2), for folder names.
local function hash(s)
  local h = 5381
  for i = 1, #s do h = (h * 33 + s:byte(i)) % 4294967296 end
  return string.format("%08x", h)
end
Checkpoints.hash = hash

local function slug(s)
  s = tostring(s or ""):gsub("%.[%w]+$", ""):gsub("[^%w%-_]+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
  if s == "" then s = "sprite" end
  return s:sub(1, 40)
end

local function baseName(path) return tostring(path or ""):match("([^/\\]+)$") or tostring(path or "") end

-- The folder name for a sprite: its file title and a hash of its path when it
-- was saved somewhere, else "unsaved-<title>-<id>".
function Checkpoints.keyFor(filename, spriteId)
  filename = tostring(filename or "")
  local saved = filename:match("^/") or filename:match("^%a:[/\\]") or filename:match("^\\\\")
  if saved then return slug(baseName(filename)) .. "-" .. hash(filename) end
  return "unsaved-" .. slug(baseName(filename)) .. "-" .. tostring(spriteId or 0)
end

function Checkpoints.new(opts)
  return setmetatable({
    dir = assert(opts.dir, "dir required"),
    keep = opts.keep or Checkpoints.KEEP,
    save = assert(opts.save, "save required"),
    remove = opts.remove or function() end,
    makeDirs = opts.makeDirs or function() end,
    listFiles = opts.listFiles or function() return {} end,
    isFile = opts.isFile or function() return true end,
    join = opts.join or function(a, b) return a .. "/" .. b end,
    clock = opts.clock or os.time,
    seq = 0,
    lastBySprite = {},   -- sprite id -> the newest record (dedupe)
    turnSeq = 0,
    turnLog = {},        -- { seq, spriteId, chat }: turns that started, newest last
  }, Checkpoints)
end

-- The sprite's current undo state id (0 before the first step).
local function undoState(sprite)
  local ok, h = pcall(function() return sprite.undoHistory end)
  if ok and h and h.current then return h.current end
  return 0
end
Checkpoints.undoState = undoState

local function hasState(sprite, id)
  if id == 0 then return true end
  local ok, h = pcall(function() return sprite.undoHistory end)
  if not ok or not h or not h.states then return false end
  for _, st in ipairs(h.states) do if st.id == id then return true end end
  return false
end

-- Removes the oldest checkpoint files of a sprite's folder past `keep`.
function Checkpoints:prune(folder)
  local files = {}
  for _, name in ipairs(self.listFiles(folder) or {}) do
    if name:match("%.aseprite$") then files[#files + 1] = name end
  end
  table.sort(files)   -- names start with a zero-padded time and sequence
  for i = 1, #files - self.keep do self.remove(self.join(folder, files[i])) end
end

-- Takes a checkpoint of the sprite. When nothing changed since the sprite's
-- last one (same undo state), that one is reused. Returns the record, or nil
-- and why.
function Checkpoints:take(sprite)
  if not sprite then return nil, "No sprite" end
  local id = sprite.id
  local undoId = undoState(sprite)
  local last = self.lastBySprite[id]
  if last and last.undoId == undoId and self.isFile(last.path) then
    local copy = {}
    for k, v in pairs(last) do copy[k] = v end
    copy.turnSeq = self.turnSeq
    copy.reused = true
    return copy
  end
  local key = Checkpoints.keyFor(sprite.filename, id)
  local folder = self.join(self.dir, key)
  self.seq = self.seq + 1
  local at = self.clock()
  local path = self.join(folder, string.format("%010d-%04d.aseprite", math.floor(at), self.seq % 10000))
  local ok, err = pcall(function()
    self.makeDirs(folder)
    self.save(sprite, path)
  end)
  if not ok then return nil, "Could not save a checkpoint: " .. tostring(err) end
  local rec = { path = path, undoId = undoId, spriteId = id, key = key, at = at, turnSeq = self.turnSeq,
                title = baseName(sprite.filename), source = sprite.filename }
  self.lastBySprite[id] = rec
  pcall(function() self:prune(folder) end)
  return rec
end

-- A turn started on a sprite (any chat); kept to tell which chats edited a
-- sprite after a checkpoint.
function Checkpoints:noteTurn(spriteId, chat)
  self.turnSeq = self.turnSeq + 1
  self.turnLog[#self.turnLog + 1] = { seq = self.turnSeq, spriteId = spriteId, chat = chat }
  if #self.turnLog > 500 then table.remove(self.turnLog, 1) end
  return self.turnSeq
end

-- The other chats that started turns on the record's sprite after it was
-- taken (their edits would be undone too), in order, each once.
function Checkpoints:othersAfter(rec, chat)
  local out, seen = {}, {}
  if not rec then return out end
  for _, t in ipairs(self.turnLog) do
    if t.seq > (rec.turnSeq or 0) and t.spriteId == rec.spriteId and t.chat ~= chat and not seen[t.chat] then
      seen[t.chat] = true
      out[#out + 1] = t.chat
    end
  end
  return out
end

-- How a checkpoint can be restored onto `sprite`: "undo" (the undo history
-- still reaches it: sprite:undoTo(rec.undoId)), "file" (only the copy is left:
-- open it as a new tab), or nil and why.
function Checkpoints:restorePlan(rec, sprite)
  if not rec then return nil, "This message has no checkpoint (it started no Agent turn)" end
  if sprite and sprite.id == rec.spriteId and hasState(sprite, rec.undoId) then return "undo" end
  if self.isFile(rec.path) then return "file" end
  return nil, string.format("This checkpoint was removed (the last %d per sprite are kept)", self.keep)
end

-- Plain data of a record, for saving the conversation (Developer relaunch).
function Checkpoints.plain(rec)
  if not rec then return nil end
  return { path = rec.path, undoId = rec.undoId, spriteId = rec.spriteId, key = rec.key, at = rec.at,
           turnSeq = rec.turnSeq, title = rec.title, source = rec.source }
end

return Checkpoints
