-- Aseprite Agent extension.
-- Connects to the local bridge over WebSocket and executes agent requests.
-- Milestone M1 implements the request loop; this file is the entry point.

local ws = nil

local function connect(plugin)
  -- TODO(M1): read port/token from plugin.preferences, open WebSocket,
  -- dispatch JSON-RPC requests inside app.transaction, reply with results.
  app.alert("Aseprite Agent: bridge connection is not implemented yet.")
end

function init(plugin)
  plugin:newCommand{
    id = "AgentConnect",
    title = "Connect AI Agent",
    group = "edit_insert",
    onclick = function() connect(plugin) end,
  }
end

function exit(plugin)
  if ws then ws:close() end
end
