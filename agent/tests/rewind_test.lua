-- Project memory and checkpoints (#93): conversation truncate and branch,
-- the recap, Turns after a truncate, checkpoint bookkeeping (fake files and
-- a real sprite's undo history), style memory on a sprite, the rewind question.
--   aseprite -b --script-param ext=<agent/extension> --script-param tmp=<dir> --script agent/tests/rewind_test.lua
local extDir = app.params.ext
local Conversation = dofile(app.fs.joinPath(extDir, "conversation.lua"))
local Turns = dofile(app.fs.joinPath(extDir, "turns.lua"))
local Checkpoints = dofile(app.fs.joinPath(extDir, "checkpoints.lua"))
local Memory = dofile(app.fs.joinPath(extDir, "project_memory.lua"))
local Prompter = dofile(app.fs.joinPath(extDir, "prompter.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local t = 0
local clock = function() return t end

-- A conversation of three turns: "draw" (tool + reply), "shade", "animate".
local function threeTurns()
  local c = Conversation.new{ clock = clock }
  c:send("draw a slime", "claude")
  c:apply{ type = "session", provider = "claude", sessionId = "s1" }
  c:apply{ type = "tool", id = "a", tool = "Draw slime", kind = "edit" }
  c:apply{ type = "tool_result", id = "a", ok = true }
  c:apply{ type = "text", text = "Drew a green slime." }
  c:apply{ type = "done" }
  c:send("shade it", "claude")
  c:apply{ type = "thinking", text = "secret thought" }
  c:apply{ type = "text", text = "Shaded." }
  c:apply{ type = "done" }
  c:send("animate it", "claude")
  c:apply{ type = "text", text = "Animated." }
  c:apply{ type = "done" }
  return c
end

local function users(c)
  local out = {}
  for _, e in ipairs(c:entries()) do if e.kind == "user" then out[#out + 1] = e end end
  return out
end

-- Truncate ------------------------------------------------------------------
do
  local c = threeTurns()
  local second = users(c)[2]
  local text = c:truncateAt(second)
  check("truncate returns the message", text == "shade it", text)
  local u = users(c)
  check("truncate keeps only earlier messages", #u == 1 and u[1].text == "draw a slime", #u)
  check("truncate forgets conversation ids", next(c:conversationIds()) == nil)
  -- The next message starts a new agent conversation with a recap.
  c:send("shade it softly", "claude")
  local recap = c:recapToSend()
  check("recap has the kept message and reply", recap and recap:find("User: draw a slime", 1, true)
    and recap:find("Agent: Drew a green slime.", 1, true), recap)
  check("recap names the steps", recap and recap:find("Agent steps: Draw slime", 1, true), recap)
  check("recap leaves out the removed turn and thoughts", recap and not recap:find("Shaded", 1, true)
    and not recap:find("secret", 1, true), recap)
  check("recap leaves out the message being sent", recap and not recap:find("softly", 1, true), recap)
  c:apply{ type = "session", provider = "claude", sessionId = "s2" }
  check("new conversation clears the recap", c:recapToSend() == nil)
  check("new id kept", c:conversationId("claude") == "s2")
end

do
  local c = threeTurns()
  c:send("one more", "claude")   -- busy
  local _, why = c:truncateAt(users(c)[1])
  check("no truncate while a turn runs", why ~= nil, why)
  local _, why2 = threeTurns():truncateAt({ kind = "user", text = "x" })
  check("truncate refuses a foreign entry", why2 ~= nil)
end

-- Branch ------------------------------------------------------------------
do
  local c = threeTurns()
  local third = users(c)[3]
  local data, text = c:branchData(third)
  check("branch returns the message text", text == "animate it")
  check("branch leaves the source chat alone", #users(c) == 3 and c:conversationId("claude") == "s1")
  local b = Conversation.new{ clock = clock }
  b:restore(json.decode(json.encode(data)))
  local u = users(b)
  check("branch keeps the messages before", #u == 2 and u[2].text == "shade it", #u)
  check("branch has no conversation ids", next(b:conversationIds()) == nil)
  b:send("animate it faster", "claude")
  local recap = b:recapToSend()
  check("branch recap covers both kept turns", recap and recap:find("Shaded.", 1, true) and recap:find("draw a slime", 1, true), recap)
  -- Rewinding the branch again does not repeat the recap.
  b:apply{ type = "session", provider = "claude", sessionId = "b1" }
  b:apply{ type = "done" }
  b:truncateAt(users(b)[3])
  b:send("again", "claude")
  local again = b:recapToSend()
  local _, count = again:gsub("User: draw a slime", "")
  check("a second rewind recaps each message once", count == 1, again)
end

-- Checkpoints survive serialize/restore on the user entry.
do
  local c = threeTurns()
  users(c)[1].checkpoint = { path = "/x/1.aseprite", undoId = 5, spriteId = 3, title = "slime.aseprite", source = "/p/slime.aseprite" }
  local d = Conversation.new{ clock = clock }
  d:restore(json.decode(json.encode(c:serialize())))
  local cp = users(d)[1].checkpoint
  check("checkpoint kept through serialize", cp and cp.path == "/x/1.aseprite" and cp.undoId == 5 and cp.source == "/p/slime.aseprite")
end

-- Memory proposals are entries with a topic.
do
  local c = Conversation.new{ clock = clock }
  c:send("keep this outline", "claude")
  c:apply{ type = "memory", topic = "outline", text = "1 px dark selout" }
  local last = c:entries()[#c:entries()]
  check("memory event makes a memory entry", last.kind == "memory" and last.topic == "outline" and last.text == "1 px dark selout")
end

-- Turns after a truncate -----------------------------------------------------
do
  local H = {}
  function H.begin(sprite) return { sprite = sprite, start = 1 } end
  function H.finish(turn) turn.finish = 2; turn.steps = {}; return turn end
  function H.status() return "done" end
  function H.changesSince(turn) return "since " .. turn.name end
  local turns = Turns.new{ Conversation = Conversation, clock = clock, history = H, sprite = function() return "s" end }
  local a = turns:start("s", { text = "one", provider = "claude" }); a.name = "one"
  turns:apply{ type = "done" }
  local b = turns:start("s", { text = "two", provider = "claude" }); b.name = "two"
  turns:apply{ type = "done" }
  check("last is the second reply", turns:lastTurn() == b)
  local text = turns:truncateAt(users(turns.conversation)[2])
  check("turns truncate returns text", text == "two")
  check("last reply is the kept one", turns:lastTurn() == a and turns:changesSince() == "since one")
  turns:truncateAt(users(turns.conversation)[1])
  check("no reply left: no last", turns:lastTurn() == nil and turns:changesSince() == nil)
end

-- Checkpoint bookkeeping with fake files --------------------------------------
do
  local files, saved, removed = {}, {}, {}
  local cp = Checkpoints.new{
    dir = "/home/cp", keep = 3, clock = clock,
    save = function(_, path) saved[#saved + 1] = path; files[path] = true end,
    remove = function(path) removed[#removed + 1] = path; files[path] = nil end,
    listFiles = function(dir)
      local out = {}
      for p in pairs(files) do if p:sub(1, #dir + 1) == dir .. "/" then out[#out + 1] = p:sub(#dir + 2) end end
      return out
    end,
    isFile = function(p) return files[p] == true end,
  }
  local undo = 10
  local sprite = { id = 7, filename = "/art/hero.aseprite", undoHistory = { current = 10, states = {} } }
  check("key of a saved sprite: title and path hash",
    Checkpoints.keyFor("/art/hero.aseprite", 7) == "hero-" .. Checkpoints.hash("/art/hero.aseprite"))
  check("key of an unsaved sprite", Checkpoints.keyFor("Sprite-0001", 7) == "unsaved-Sprite-0001-7")
  t = 100
  local r1 = cp:take(sprite)
  check("take saves a file in the sprite's folder", r1 and #saved == 1 and r1.path:find("/home/cp/hero-", 1, true) == 1, r1 and r1.path)
  check("take records the undo state", r1.undoId == 10 and r1.spriteId == 7 and r1.source == "/art/hero.aseprite")
  local r2 = cp:take(sprite)
  check("nothing changed: reused, no new file", #saved == 1 and r2.path == r1.path and r2.reused)
  for i = 1, 4 do
    undo = undo + 1
    sprite.undoHistory.current = undo
    t = t + 1
    cp:take(sprite)
  end
  check("keeps the last 3 files", #removed == 2 and not files[r1.path], #removed)
  check("restore plan of a pruned file and lost state is nil", cp:restorePlan(r1, { id = 99 }) == nil)

  -- Other chats' turns on the same sprite after a checkpoint.
  local rec = cp:take(sprite)
  cp:noteTurn(7, "c1")
  cp:noteTurn(8, "c2")
  check("no other chat yet", #cp:othersAfter(rec, "c1") == 0)
  cp:noteTurn(7, "c3")
  cp:noteTurn(7, "c3")
  local others = cp:othersAfter(rec, "c1")
  check("other chats after the checkpoint, once each", #others == 1 and others[1] == "c3")
  check("a missing checkpoint has no plan", cp:restorePlan(nil, sprite) == nil)
end

-- Checkpoints of a real sprite: undo restore and the file copy -----------------
do
  local tmp = app.params.tmp or app.fs.tempPath
  local dir = app.fs.joinPath(tmp, "rewind-checkpoints")
  local cp = Checkpoints.new{
    dir = dir, keep = 20,
    save = function(sprite, path) sprite:saveCopyAs(path) end,
    makeDirs = function(d) app.fs.makeAllDirectories(d) end,
    listFiles = function(d) return app.fs.isDirectory(d) and app.fs.listFiles(d) or {} end,
    isFile = function(p) return app.fs.isFile(p) end,
    join = function(a, b) return app.fs.joinPath(a, b) end,
  }
  local s = Sprite(8, 8, ColorMode.RGB)
  -- Undoable pixel edits: a new image for the cel in a transaction.
  local function dot(label, x, y, c)
    app.transaction(label, function()
      local img = s.cels[1].image:clone()
      img:drawPixel(x, y, c)
      s.cels[1].image = img
    end)
  end
  dot("Dot", 1, 1, app.pixelColor.rgba(255, 0, 0, 255))
  local rec = cp:take(s)
  check("real checkpoint written", rec and app.fs.isFile(rec.path), rec and rec.path)
  dot("Second dot", 2, 2, app.pixelColor.rgba(0, 255, 0, 255))
  check("second dot drawn", s.cels[1].image:getPixel(2, 2) ~= 0)
  check("undo plan while the history reaches it", cp:restorePlan(rec, s) == "undo")
  s:undoTo(rec.undoId)
  check("undoTo restores the pixels", s.cels[1].image:getPixel(2, 2) == 0 and s.cels[1].image:getPixel(1, 1) ~= 0)
  local copy = Sprite{ fromFile = rec.path }
  check("the file holds the sprite then", copy.cels[1].image:getPixel(1, 1) ~= 0 and copy.cels[1].image:getPixel(2, 2) == 0)
  check("another sprite gets the file plan", cp:restorePlan(rec, copy) == "file")
  copy:close()

  -- Style memory on the real sprite: one undo step per entry, in the State block lines.
  Memory.remember(s, "outline", "1 px dark selout")
  Memory.remember(s, "note", "eyes are 2 px")
  Memory.remember(s, "outline", "no outline inside")
  local list = Memory.entries(s)
  check("memory: outline replaced, note kept", #list == 2 and list[1].topic == "outline" and list[1].text == "no outline inside"
    and list[2].text == "eyes are 2 px", json.encode(list))
  app.undo()
  check("memory: remembering is one undo step", #Memory.entries(s) == 2 and Memory.entries(s)[1].text == "1 px dark selout",
    json.encode(Memory.entries(s)))
  local lines = Memory.stateLines(Memory.entries(s))
  check("memory: State block lines", lines and lines[1]:find("style memory", 1, true) and lines[2] == "  outline: 1 px dark selout",
    lines and table.concat(lines, "|"))
  Memory.forget(s, 1)
  check("memory: forget", #Memory.entries(s) == 1)
  s:close()
end

-- Pure memory merge rules.
do
  local l = Memory.merge({}, { topic = "palette", text = "  #222 = outline \n" })
  l = Memory.merge(l, { topic = "note", text = "a" })
  l = Memory.merge(l, { topic = "scale", text = "16x16" })
  l = Memory.merge(l, { topic = "note", text = "a" })
  l = Memory.merge(l, { topic = "bogus", text = "b" })
  check("merge: sorted by topic, no duplicate note, unknown topic is a note",
    #l == 4 and l[1].topic == "palette" and l[1].text == "#222 = outline" and l[2].topic == "scale" and l[3].text == "a" and l[4].text == "b",
    json.encode(l))
  check("no memory, no State block lines", Memory.stateLines({}) == nil)
end

-- The rewind question.
do
  local q = Prompter.rewindQuestion{ text = "make it blue", plan = "undo", own = true, warnings = { "Other chats edited" } }
  check("rewind question buttons", #q.buttons == 5 and q.buttons[4] == "Branch from here" and Prompter.REWIND_CHOICES[4] == "branch")
  local joined = table.concat(q.text, "\n")
  check("rewind question says how the sprite comes back", joined:find("Redo", 1, true) and joined:find("Other chats edited", 1, true))
  local q2 = Prompter.rewindQuestion{ text = "x", plan = nil, why = "No Agent turn ran" }
  check("rewind question without a checkpoint says why", table.concat(q2.text, "\n"):find("No Agent turn ran", 1, true))
end

print(failures == 0 and "ALL REWIND TESTS PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " rewind tests failed") end
