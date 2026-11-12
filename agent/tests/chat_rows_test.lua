-- Chat rows (#115): the log's layout without the panel, drawn into a recording gc.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/chat_rows_test.lua
local extDir = app.params.ext
local Rows = dofile(app.fs.joinPath(extDir, "chat_rows.lua"))
local Mascot = dofile(app.fs.joinPath(extDir, "mascot.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- A gc that measures 6 px per byte and 12 px per line, and records every text it draws.
local function recorder()
  local texts = {}
  local gc = setmetatable({ texts = texts }, { __index = function(t, k)
    if k == "measureText" then return function(_, s) return { width = #s * 6, height = 12 } end end
    if k == "fillText" then return function(_, s, x, y) texts[#texts + 1] = { s = s, x = x, y = y } end end
    return function() end
  end })
  return gc
end

local entries, busy = {}, false
local conv = { entries = function() return entries end, isBusy = function() return busy end, elapsed = function() return 3 end }
local turns = { view = function() return "done", "revert", false end }
local mood = { current = function() return "idle", 0 end }
local colors = setmetatable({}, { __index = function() return Color(200, 200, 200) end })
local rows = Rows.new{
  C = colors, expanded = {}, chats = { current = { mood = mood, queue = { { shown = "a queued message that is long" } } } },
  deps = { Conversation = { parseLinks = function(t) return t, {} end }, resolveUri = function() return nil end },
  Mascot = Mascot, memoryOptions = { "Remember", "Don't remember" }, thumbCache = {}, thumbWanted = {},
  conv = function() return conv end, turns = function() return turns end, animT = function() return 0 end,
}

local function paint(w)
  local gc = recorder()
  local list, pad, hits = rows.build(gc, w)
  local y = pad
  for _, r in ipairs(list) do r.draw(y); y = y + r.h + r.gap end
  return list, hits, gc.texts
end

-- An empty chat: the hint.
local list, _, texts = paint(300)
local hint
for _, t in ipairs(texts) do if t.s:match("^Ask the agent") then hint = t end end
check("empty chat: a hint row", hint ~= nil)

-- A turn: the user's message wraps in its bubble; a header with Revert; a tool step; a reply; a question card.
entries = {
  { kind = "user", text = "make the knight wave his sword over his head please" },
  { kind = "header", text = "Claude" },
  { kind = "tool", text = "Motion clip: plan", toolKind = "edit", status = "ok", detail = "tag wave" },
  { kind = "text", text = "Planned the wave: keys 1 and 4." },
  { kind = "question", text = "Keep the sword?", options = { "Keep", "Remove" } },
  { kind = "worked", secs = 12, check = { errors = 0, warnings = 0 } },
}
local list2, hits, texts2 = paint(200)
local function drawn(pattern) for _, t in ipairs(texts2) do if t.s:match(pattern) then return t end end end
check("user text wraps to the bubble", drawn("^make the knight") and not drawn("please$") == false and #texts2 > 6)
local maxUser = 0
for _, t in ipairs(texts2) do if t.s:match("knight") or t.s:match("sword") or t.s:match("please") then maxUser = math.max(maxUser, #t.s * 6) end end
check("no line is wider than the bubble's room", maxUser <= math.floor(200 * 0.8), maxUser)
check("a step row shows its label", drawn("^Motion clip: plan") ~= nil)
check("the reply is drawn", drawn("^Planned the wave") ~= nil)
local actions = {}
for _, b in ipairs(hits.buttons) do actions[#actions + 1] = b.action end
local list3 = table.concat(actions, ",")
check("buttons: rewind, revert, the question's options, queue controls", list3:match("rewind") and list3:match("revert")
  and select(2, list3:gsub("answer_question", "")) == 2 and list3:match("queue_send_now") and list3:match("queue_remove"), list3)
check("worked row with a check badge", drawn("^Worked for 12s") ~= nil and drawn("^Checked") ~= nil)
check("a queued message is cut to fit with an ellipsis", (function()
  for _, t in ipairs(texts2) do if t.s:match("…$") then return true end end end)())
-- A step with detail is clickable (its entry); expanding it adds the detail row.
local clickable = 0
for _, r in ipairs(list2) do if r.entry then clickable = clickable + 1 end end
check("the tool step with detail is clickable", clickable == 1, clickable)
-- Hits come back fresh per build.
local _, hitsAgain = paint(200)
check("hits are per build", hitsAgain.buttons ~= hits.buttons and #hitsAgain.buttons == #hits.buttons)

-- Wrapping keeps UTF-8 whole (Korean) and hard-breaks long words.
local lines = Rows.wrap(recorder(), "레이어 " .. string.rep("x", 40), 60)
local ok = true
for _, l in ipairs(lines) do if not utf8.len(l) or #l * 6 > 60 then ok = false end end
check("wrap: valid UTF-8 and within the width", ok and #lines >= 4, #lines)
check("dropLastChar keeps UTF-8 whole", Rows.dropLastChar("ab…") == "ab" and Rows.formatSeconds(75) == "1m 15s")

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
