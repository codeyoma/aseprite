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
end
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
