-- Saved Commands (#26): commands the agent saved with save_command, shown in
-- File > Scripts > AI Agent > My Commands and run with /name in the chat.
-- The bridge writes the folder (commands.json, <name>.lua, git history);
-- this module reads it and registers the menu entries.
--
--   local Saved = dofile("saved_commands.lua").new{ dir, readFile, plugin, executeLua }
--   Saved:reload()                  -- (re)register menu entries from commands.json
--   Saved:run("outline-dark", args) -- result of executeLua
--   Saved.parseArgs("width=2 dark") -- { width = 2, dark = true }

local M = {}
M.__index = M

M.GROUP = "ai_agent_my_commands"

function M.new(opts)
  return setmetatable({
    dir = opts.dir,
    readFile = assert(opts.readFile, "readFile required"),
    plugin = opts.plugin,
    executeLua = assert(opts.executeLua, "executeLua required"),
    list = {},
    registered = {},
  }, M)
end

function M:path(name) return app.fs.joinPath(self.dir, name .. ".lua") end

-- Reads commands.json; returns the list (also kept in self.list).
function M:load()
  local text = self.readFile(app.fs.joinPath(self.dir, "commands.json"))
  local ok, data = pcall(function() return text and json.decode(text) end)
  -- json.decode returns JSON objects; copy them into plain tables.
  self.list = {}
  for _, c in ipairs((ok and data and data.commands) or {}) do
    local params = {}
    for _, p in ipairs(c.params or {}) do
      params[#params + 1] = { name = p.name, description = p.description, default = p.default }
    end
    self.list[#self.list + 1] = { name = c.name, title = c.title, description = c.description,
      enabled = c.enabled ~= false, params = params, updated = c.updated }
  end
  return self.list
end

function M:get(name)
  for _, c in ipairs(self.list) do if c.name == name then return c end end
  return nil
end

-- Declared defaults, then the given arguments.
function M.withDefaults(cmd, args)
  local out = {}
  for _, p in ipairs(cmd.params or {}) do
    if p.default ~= nil then out[p.name] = p.default end
  end
  for k, v in pairs(args or {}) do out[k] = v end
  return out
end

-- "width=2 color=#ff0000 dark" -> { width = 2, color = "#ff0000", dark = true }
function M.parseArgs(text)
  local args = {}
  for token in (text or ""):gmatch("%S+") do
    local k, v = token:match("^([%w_%-]+)=(.*)$")
    if k then
      if v == "true" then v = true elseif v == "false" then v = false
      elseif tonumber(v) then v = tonumber(v) end
      args[k] = v
    else
      args[token] = true
    end
  end
  return args
end

-- Runs a saved command as one undo step. Returns the executeLua result,
-- or { ok = false, error } when it can't be found.
function M:run(name, args)
  if #self.list == 0 then self:load() end
  local cmd = self:get(name)
  if not cmd then return { ok = false, error = "No saved command named " .. tostring(name) } end
  local code = self.readFile(self:path(name))
  if not code then return { ok = false, error = "The file for " .. name .. " is missing" } end
  return self.executeLua{ code = code, label = cmd.title, args = M.withDefaults(cmd, args) }
end

-- Registers a menu entry per enabled command (removing old ones first).
function M:reload(dir)
  if dir then self.dir = dir end
  self:load()
  if not self.plugin then return self.list end
  for id in pairs(self.registered) do pcall(function() self.plugin:deleteCommand(id) end) end
  self.registered = {}
  if not self.groupMade then
    self.plugin:newMenuGroup{ id = M.GROUP, title = "My Commands", group = "ai_agent_menu" }
    self.groupMade = true
  end
  for _, c in ipairs(self.list) do
    if c.enabled ~= false then
      local id = "AgentCmd_" .. c.name:gsub("%-", "_")
      self.plugin:newCommand{
        id = id, title = c.title, group = M.GROUP,
        onenabled = function() return app.sprite ~= nil end,
        onclick = function()
          local r = self:run(c.name, {})
          if not r.ok then app.alert{ title = c.title, text = tostring(r.error) } end
        end,
      }
      self.registered[id] = true
    end
  end
  return self.list
end

return M
