-- Chats (#89): chats per sprite, queues, who runs next, the request gate and
-- rehoming, without the panel.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/chats_test.lua
local Chats = dofile(app.fs.joinPath(app.params.ext, "chats.lua"))
local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local open = { [1] = true, [2] = true }
local function fakeConv() local e = {} return { entries = function() return e end, add = function() e[#e + 1] = 1 end } end
local chats = Chats.new{
  parts = function(chat, first) chat.conv = fakeConv(); chat.first = first end,
  spriteExists = function(id) return open[id] == true end,
}
local a1 = chats:make(1, true)
check("first chat is on screen", chats.current == a1 and a1.first and a1.key == "s1")
local a2 = chats:make(1)
check("two chats on sprite 1", #chats:list() == 2 and chats.current == a1)
chats:show(a2)
check("show", chats.current == a2)

-- Switching sprites.
local b1 = chats:siteChanged(2)
check("sprite 2 gets its own chat", b1 and b1.key == "s2" and #chats:list() == 1)
check("back to sprite 1 shows its last chat", chats:siteChanged(1) == a2)
check("same sprite: nothing to switch", chats:siteChanged(1) == nil)

-- Queue: one turn at a time, the chat on screen first.
chats:start(a1)
chats:enqueue(b1, { shown = "for b" })
chats:enqueue(a2, { shown = "for a2" })
check("nothing goes while a turn runs", chats:nextToSend() == nil)
chats:finish(a1)
local c, r = chats:nextToSend()
check("the chat on screen goes first", c == a2 and r.shown == "for a2" and r.queued)
c, r = chats:nextToSend()
check("then the others", c == b1 and r.shown == "for b")

-- Stop pauses; Send now resumes and asks to stop a running turn.
chats:start(a1)
chats:enqueue(a2, { shown = "x" }); chats:enqueue(a2, { shown = "y" })
chats:stop()
check("stop pauses the running chat's queue only if it has one", a2.queuePaused == false)
chats:show(a2)
chats.running = a2
chats:stop()
check("stop pauses", a2.queuePaused == true)
chats.running = a1
local ok, mustStop = chats:sendNow(2)
check("send now moves y first, unpauses, and must stop the turn", ok and mustStop and a2.queue[1].shown == "y" and not a2.queuePaused)
check("remove queued", chats:removeQueued(2) and #a2.queue == 1)
chats:finish(a1)

-- Gate: hold while the running chat's sprite is not active; error when closed.
chats:start(a1)
local g, changed = chats:gate(2)
check("hold on another sprite", g == "hold" and changed and a1.waiting)
g, changed = chats:gate(1)
check("run on its sprite", g == true and changed and not a1.waiting)
open[1] = false
check("closed sprite: error", chats:gate(1) == "The sprite this chat works on was closed")
open[1] = true
chats:finish(a1)
check("no turn: always run", chats:gate(2) == true)

-- Close: not the running chat; the last chat is replaced.
chats:start(a2)
check("can't close the running chat", not chats:close(a2.id))
chats:finish(a2)
local okc, why, show = chats:close(a2.id)
check("close the chat on screen shows another", okc and show == a1 and chats.current == a1)
local okl, _, replacement = chats:close(a1.id)
check("closing the last chat makes an empty one", okl and replacement and replacement ~= a1 and #chats:list() == 1)

-- Rehome: the running chat follows a sprite the agent made; an empty chat there gives way.
local cur = chats.current
chats:start(cur)
open[3] = true
chats:siteChanged(3)                -- the panel made an empty chat for sprite 3
chats:rehome(cur, 3)
check("rehome moves the chat and drops the empty one", cur.key == "s3" and #chats.groups.s3.list == 1 and chats.groups.s3.current == cur)
chats:finish(cur)

-- Closed sprites' chats go, except the running one.
open[2] = false
chats:siteChanged(3)
check("closed sprite's chats dropped", chats.groups.s2 == nil and chats:get(b1.id) == nil)
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
