-- Aseprite Agent extension: the plugin entry. It wires three modules:
--
--   document_handlers.lua  what the bridge can ask of Aseprite (no transport)
--   bridge_connection.lua  session file, WebSocket, handshake, reconnects
--   chat_panel.lua         the AI Agent chat panel (with conversation.lua)
--
-- protocol.json is the wire protocol shared with the bridge.

local Panel, connection

local function loadProtocol(dir)
  local f = assert(io.open(app.fs.joinPath(dir, "protocol.json"), "r"), "protocol.json missing from the extension")
  local p = json.decode(f:read("a"))
  f:close()
  return p
end

function init(plugin)
  local function load(name) return dofile(app.fs.joinPath(plugin.path, name)) end
  local protocol = loadProtocol(plugin.path)

  local handlers = load("document_handlers.lua").new{ chunkDir = plugin.path, protocol = protocol }

  connection = load("bridge_connection.lua").new{
    protocol = protocol,
    preferences = plugin.preferences,
    onRequest = handlers.call,
    onNotification = function(method, params)
      if method == "chat.event" and Panel then Panel.onEvent(params) end
    end,
    onConnectionChange = function(isConnected)
      if Panel then Panel.onConnectionChange(isConnected) end
    end,
    -- File, shell and socket access stay in this (trusted) script, because
    -- Aseprite asks permission per script file; see bridge_connection.lua.
    readFile = function(path)
      local f = io.open(path, "r")
      if not f then return nil end
      local text = f:read("a")
      f:close()
      return text
    end,
    runShell = function(command) os.execute(command) end,
    openSocket = function(args) return WebSocket(args) end,
  }

  Panel = load("chat_panel.lua"){
    Conversation = load("conversation.lua"),
    request = connection.request,
    isConnected = connection.isConnected,
    contextString = handlers.contextString,
    ensureBridge = connection.ensureBridge,
    preferences = plugin.preferences,
  }

  -- Scripting API for other scripts: AsepriteAgent.chat("make it blue")
  AsepriteAgent = {
    chat = function(prompt, provider) Panel.submit(prompt, provider) end,
    isBusy = function() return Panel.isBusy() end,
    entries = function() return Panel.entries() end,
    openPanel = function() Panel.open() end,
    closePanel = function() Panel.close() end,
    isPanelOpen = function() return Panel.isOpen() end,
    promptText = function() return Panel.promptText() end,
    setPrompt = function(text) Panel.setPrompt(text) end,
    expandAll = function(state) Panel.expandAll(state) end,
  }

  plugin:newMenuGroup{
    id = "ai_agent_menu",
    title = "AI Agent",
    group = "file_scripts",
  }

  -- Also run by the "AI" button next to the workspace layout button.
  plugin:newCommand{
    id = "AgentChat",
    title = "Toggle Chat Panel",
    group = "ai_agent_menu",
    onclick = function()
      if Panel.isOpen() then Panel.close() else Panel.open() end
    end,
  }

  plugin:newCommand{
    id = "AgentConnect",
    title = "Connect",
    group = "ai_agent_menu",
    onclick = function()
      plugin.preferences.autoconnect = true
      connection.connect(false)
    end,
  }

  plugin:newCommand{
    id = "AgentDisconnect",
    title = "Disconnect",
    group = "ai_agent_menu",
    onclick = function()
      plugin.preferences.autoconnect = false
      connection.disconnect()
      app.tip("AI Agent disconnected")
    end,
  }

  if app.events then
    app.events:on("sitechange", function() Panel.refreshContext() end)
  end

  -- Auto-connect by default; the menu's Disconnect turns it off.
  if plugin.preferences.autoconnect ~= false then
    connection.connect(true)
  end
end

function exit(plugin)
  if connection then connection.disconnect() end
end
