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

  local capture = load("step_capture.lua").new{ limit = 50 }
  local handlers = load("document_handlers.lua").new{ chunkDir = plugin.path, protocol = protocol, capture = capture,
    onVariations = function(info) if Panel then Panel.showVariations(info) end end }

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
    stateBlock = handlers.stateBlock,
    mentionTargets = handlers.Uri.targets,
    resolveUri = handlers.Uri.resolve,
    selectUri = handlers.Uri.select,
    TurnHistory = load("turn_history.lua"),
    variations = handlers.variations,
    attachments = load("attachments.lua").new{
      dir = app.fs.joinPath(os.getenv("HOME") or app.fs.userConfigPath, ".aseprite-agent", "attachments"),
      snapshot = handlers.snapshot, Uri = handlers.Uri,
      writeImage = function(img, path)
        app.fs.makeAllDirectories(app.fs.filePath(path))
        img:saveAs(path)
      end,
    },
    capture = capture,
    ensureBridge = connection.ensureBridge,
    preferences = plugin.preferences,
  }

  -- Scripting API for other scripts: AsepriteAgent.chat("make it blue")
  AsepriteAgent = {
    chat = function(prompt, provider, mode) Panel.submit(prompt, provider, mode) end,
    -- Keeps variation i of the newest variations, or discards them (nil) (#25).
    pickVariation = function(i) return Panel.resolveVariations(i) end,
    discardVariations = function() return Panel.resolveVariations(nil) end,
    -- Carries out the last Plan-mode reply (#24).
    applyPlan = function()
      local list = Panel.entries()
      for i = #list, 1, -1 do
        if list[i].applyPlan then return Panel.applyLastPlan() end
      end
      return false
    end,
    isBusy = function() return Panel.isBusy() end,
    entries = function() return Panel.entries() end,
    openPanel = function() Panel.open() end,
    closePanel = function() Panel.close() end,
    isPanelOpen = function() return Panel.isOpen() end,
    promptText = function() return Panel.promptText() end,
    setPrompt = function(text) Panel.setPrompt(text) end,
    expandAll = function(state) Panel.expandAll(state) end,
    mention = function(name, uri) Panel.mention(name, uri) end,
    revertLast = function(force)
      local t = Panel.lastTurn()
      if not t then return false end
      if force then return load("turn_history.lua").revert(t, true) end
      return Panel.turnAction(t, "revert")
    end,
    restoreLast = function() local t = Panel.lastTurn(); return t and Panel.turnAction(t, "restore") end,
    setPermissionAnswer = function(fn) Panel.permissionAnswer = fn end,
    -- Feeds a chat event to the panel as if the bridge sent it (tests).
    applyEvent = function(ev) Panel.onEvent(ev) end,
    -- Attach "selection" | "layer" | "frame", or { path = "ref.png" } (#21).
    attach = function(kind) return Panel.attach(kind) end,
    pendingAttachments = function() return Panel.pendingAttachments() end,
    -- The newest before/after capture of an edit request (#23).
    lastCapture = function()
      local c = capture:last()
      return c and { seq = c.seq, method = c.method, changed = c.changed, claimed = c.claimed or false } or nil
    end,
    stop = function() connection.request("chat.stop", {}, function() end) end,
    lastTurnStatus = function() local t = Panel.lastTurn(); return t and load("turn_history.lua").status(t) end,
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

  -- Attach to the chat from the menus and the timeline's context menus (#21).
  local function attachCommand(id, title, group, kind)
    plugin:newCommand{ id = id, title = title, group = group, onclick = function() Panel.attach(kind) end,
      onenabled = function() return app.sprite ~= nil end }
  end
  attachCommand("AgentAttachSelection", "Attach Selection to Chat", "ai_agent_menu", "selection")
  attachCommand("AgentAttachLayer", "Attach Active Layer to Chat", "ai_agent_menu", "layer")
  attachCommand("AgentAttachFrame", "Attach Active Frame to Chat", "ai_agent_menu", "frame")
  attachCommand("AgentAttachCel", "Attach to AI Chat", "cel_popup_properties", "layer")
  attachCommand("AgentAttachLayerPopup", "Attach to AI Chat", "layer_popup_properties", "layer")
  attachCommand("AgentAttachFramePopup", "Attach to AI Chat", "frame_popup_properties", "frame")

  if app.events then
    app.events:on("sitechange", function() Panel.refreshContext() end)
    -- Undo/redo from the Edit menu changes which replies are applied.
    app.events:on("aftercommand", function() Panel.refreshContext() end)
  end

  -- Auto-connect by default; the menu's Disconnect turns it off.
  if plugin.preferences.autoconnect ~= false then
    connection.connect(true)
  end
end

function exit(plugin)
  if connection then connection.disconnect() end
end
