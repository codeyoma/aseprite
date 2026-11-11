-- The chat panel module loads and builds its state with every global it
-- reads declared (#94): a use before a local's declaration reads a nil
-- global and stopped the whole extension from loading once.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/panel_load_test.lua
local ext = app.params.ext
local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local Conversation = dofile(app.fs.joinPath(ext, "conversation.lua"))
local Turns = dofile(app.fs.joinPath(ext, "turns.lua"))
local history = { begin = function() return {} end, finish = function() end, changesSince = function() return nil end }
local function newTurns() return Turns.new{ Conversation = Conversation, clock = os.time, history = history } end
local deps = {
  Conversation = Conversation, turns = newTurns(), newTurns = function() return newTurns() end,
  prompter = { tip = function() end, ask = function() return 2 end },
  request = function() end, isConnected = function() return false end, contextString = function() return "" end,
  stateBlock = function() return "" end, mentionTargets = function() return {} end, resolveUri = function() end,
  selectUri = function() end, savedCommands = nil, saveForRelaunch = function() end, variations = function() return {} end,
  preferences = {}, ensureBridge = function() end,
}

-- Unknown globals are errors while the panel is built.
local strict = setmetatable({}, { __index = function(_, k)
  local v = rawget(_G, k)
  if v == nil then error("undeclared global '" .. tostring(k) .. "'", 2) end
  return v
end, __newindex = function(_, k) error("assignment to global '" .. tostring(k) .. "'", 2) end })
local chunk = assert(loadfile(app.fs.joinPath(ext, "chat_panel.lua"), "t", strict))
local ok, Panel = pcall(function() return chunk()(deps) end)
check("chat_panel builds with no undeclared globals", ok, Panel)
if ok then
  check("a chat exists", Panel.currentChat() ~= nil)
  local id = Panel.newChat()
  check("new chat", id ~= nil and Panel.currentChat() == id)
  check("not busy", Panel.isBusy() == false)

  -- #93: a style memory proposal and a rewind of the conversation, through the panel.
  Panel.showChat(Panel.chats()[1].id)
  local conv = deps.turns.conversation
  conv:send("draw a slime", "claude")
  Panel.onEvent{ type = "memory", topic = "outline", text = "1 px dark selout" }
  Panel.onEvent{ type = "done" }
  local last
  for _, e in ipairs(Panel.entries()) do if e.kind == "memory" then last = e end end
  check("memory card entry", last and last.topic == "outline" and last.answered == nil)
  check("don't remember answers the card", Panel.answerMemory and Panel.answerLastMemory(2) == true)
  check("restore sprite without a checkpoint is refused", Panel.rewindUser(1, "sprite") == false)
  check("restore conversation", Panel.rewindUser(1, "conversation") == true)
  local users = 0
  for _, e in ipairs(Panel.entries()) do if e.kind == "user" then users = users + 1 end end
  check("the message is gone", users == 0)
end
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
