-- Aseprite Agent extension: the plugin entry. It wires these modules:
--
--   document_handlers.lua  what the bridge can ask of Aseprite (no transport)
--   document_view.lua      how the document is described (State block, URIs)
--   bridge_connection.lua  session file, WebSocket, handshake, reconnects
--   chat_panel.lua         the AI Agent chat panel (with composer.lua)
--   turns.lua              the Turn controller (conversation.lua, turn_history.lua)
--   prompter.lua           how the panel asks the user (app.alert, or scripted answers)
--
-- protocol.json is the wire protocol shared with the bridge.

local Panel, connection

local function loadProtocol(dir)
  local f = assert(io.open(app.fs.joinPath(dir, "protocol.json"), "r"), "protocol.json missing from the extension")
  local p = json.decode(f:read("a"))
  f:close()
  return p
end

-- Developer mode relaunch (#28): the conversation and open sprites survive
-- the restart through ~/.aseprite-agent/relaunch.
-- The agent's folder: ASEPRITE_AGENT_HOME when set (the dev instance has its
-- own), else ~/.aseprite-agent. The bridge (session.ts sessionDir) uses the
-- same rule, and a daemon bridge started from here inherits the variable.
local function agentHome()
  return os.getenv("ASEPRITE_AGENT_HOME")
    -- Windows: USERPROFILE first, like Node's os.homedir(), even when HOME is set (Git, Emacs).
    or app.fs.joinPath((app.os.windows and os.getenv("USERPROFILE")) or os.getenv("HOME") or os.getenv("USERPROFILE")
      or app.fs.userConfigPath, ".aseprite-agent")
end
local relaunchDir = app.fs.joinPath(agentHome(), "relaunch")

local function saveForRelaunch(conversation)
  app.fs.makeAllDirectories(relaunchDir)
  local sprites = {}
  for i, s in ipairs(app.sprites) do
    local backup = app.fs.joinPath(relaunchDir, string.format("%d-%s.aseprite", i, app.fs.fileTitle(s.filename)))
    s:saveCopyAs(backup)
    sprites[#sprites + 1] = { backup = backup, filename = s.filename, modified = s.isModified, active = (s == app.sprite) or nil }
  end
  local f = assert(io.open(app.fs.joinPath(relaunchDir, "state.json"), "w"))
  f:write(json.encode{ conversation = conversation, sprites = sprites })
  f:close()
  -- Close without the "save changes?" prompt; the copies above keep the work.
  for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
end

local function restoreAfterRelaunch()
  local path = app.fs.joinPath(relaunchDir, "state.json")
  local f = io.open(path, "r")
  if not f then return nil end
  local ok, data = pcall(json.decode, f:read("a"))
  f:close()
  os.remove(path)
  if not ok or not data then return nil end
  -- app.sprites lists the newest first: open in reverse to keep the tab
  -- order, then make the sprite that was active active again.
  local list, active = data.sprites or {}, nil
  for i = #list, 1, -1 do
    local s = list[i]
    local sprite = app.open(s.backup)
    -- Saving goes back to the original file; unsaved work came from the copy.
    if sprite and s.filename and app.fs.isFile(s.filename) then sprite.filename = s.filename end
    if sprite and s.active then active = sprite end
    os.remove(s.backup)
  end
  if active then app.sprite = active end
  return data.conversation
end

-- File access stays in this (trusted) script: Aseprite asks permission per script file.
local function readFile(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("a")
  f:close()
  return text
end

function init(plugin)
  local function load(name) return dofile(app.fs.joinPath(plugin.path, name)) end
  local saved   -- saved commands (#26), created below
  local protocol = loadProtocol(plugin.path)

  local DocumentHandlers = load("document_handlers.lua")
  -- Every write request is captured (the operation policy in protocol.json).
  local capture = load("step_capture.lua").new{ limit = 50, edits = DocumentHandlers.writes(protocol) }
  local view = load("document_view.lua").new{ px = load("pixels.lua") }
  local handlers = DocumentHandlers.new{ chunkDir = plugin.path, protocol = protocol, capture = capture,
    onVariations = function(info) if Panel then Panel.showVariations(info) end end,
    -- The bridge says which folder it saved to (ASEPRITE_AGENT_COMMANDS can move it).
    onCommandsChanged = function(dir) if saved then saved:reload(dir) end end,
    -- Writing files stays in this script (Aseprite asks permission per script file).
    writePalette = function(pal, path) pal:saveAs(path) end }
  -- Alerts wrap long text (Prompter.alert), so a long message grows the alert down, not sideways.
  local Prompter = load("prompter.lua")
  saved = load("saved_commands.lua").new{
    dir = app.fs.joinPath(agentHome(), "commands"),
    readFile = readFile, plugin = plugin, executeLua = handlers.executeLua, alert = Prompter.alert,
  }

  connection = load("bridge_connection.lua").new{
    protocol = protocol, alert = Prompter.alert,
    preferences = plugin.preferences,
    -- A chat turn's request (origin "chat") goes through the panel, which
    -- runs it on its chat's sprite (whichever tab is active) and moves the
    -- chat to a sprite the request opens or makes.
    -- blob: the request's binary frame (#95), the pixels its params refer to.
    -- doc (#90): the sprite the request names (the envelope's doc); a chat's requests default to its sprite.
    onRequest = function(method, params, origin, chat, blob, doc)
      if Panel and origin == "chat" then return Panel.handleRequest(handlers.call, chat, method, params, blob, doc) end
      return handlers.call(method, params, blob, doc ~= nil and { doc = doc } or nil)
    end,
    onNotification = function(method, params)
      if method == "chat.event" and Panel then Panel.onEvent(params) end
    end,
    onConnectionChange = function(isConnected)
      if Panel then Panel.onConnectionChange(isConnected) end
    end,
    -- File, shell and socket access stay in this (trusted) script, because
    -- Aseprite asks permission per script file; see bridge_connection.lua.
    readFile = readFile,
    runShell = function(command) os.execute(command) end,
    openSocket = function(args) return WebSocket(args) end,
  }

  -- Checkpoints (#93): a copy of a chat's sprite before each Agent turn, in
  -- ~/.aseprite-agent/checkpoints/<sprite>/ (the last 20 per sprite). Saving
  -- and removing files stays in this script.
  local checkpoints = load("checkpoints.lua").new{
    dir = app.fs.joinPath(agentHome(), "checkpoints"), keep = 20,
    save = function(sprite, path) sprite:saveCopyAs(path) end,
    remove = function(path) os.remove(path) end,
    makeDirs = function(dir) app.fs.makeAllDirectories(dir) end,
    listFiles = function(dir) return app.fs.isDirectory(dir) and app.fs.listFiles(dir) or {} end,
    isFile = function(path) return path ~= nil and app.fs.isFile(path) end,
    join = function(a, b) return app.fs.joinPath(a, b) end,
    clock = os.time,
  }
  -- Opens a checkpoint as a new tab under a name of its own next to the
  -- original ("hero-branch.aseprite", "-branch-2", ...), so Save never writes
  -- into the checkpoints folder or over the user's file.
  local function openCheckpoint(rec, kind)
    if not rec or not app.fs.isFile(rec.path) then return nil end
    local sprite = app.open(rec.path)
    if not sprite then return nil end
    local source = tostring(rec.source or "")
    local dir = app.fs.filePath(source)
    local title = app.fs.fileTitle(source ~= "" and source or rec.path)
    local base = title .. "-" .. kind
    if dir ~= "" and app.fs.isDirectory(dir) then
      local name, n = app.fs.joinPath(dir, base .. ".aseprite"), 1
      while app.fs.isFile(name) do
        n = n + 1
        name = app.fs.joinPath(dir, base .. "-" .. n .. ".aseprite")
      end
      sprite.filename = name
    else
      sprite.filename = base
    end
    return sprite
  end

  local Conversation = load("conversation.lua")
  local Turns, TurnHistory = load("turns.lua"), load("turn_history.lua")
  local turns = Turns.new{ Conversation = Conversation, clock = os.time,
    history = TurnHistory, capture = capture, sprite = function() return app.sprite end }
  -- Scripted answers (tests): question id ("permission", "developer",
  -- "apply", "discard", "revert"; "*" for any) -> function(question) -> button
  -- index or true/false. Unanswered questions show the usual alert.
  local answers = {}
  local prompter = Prompter.scripted(function(q)
    local fn = answers[q.id] or answers["*"]
    if fn then return fn(q) end
  end, Prompter.app())

  Panel = load("chat_panel.lua"){
    Conversation = Conversation,
    turns = turns,
    -- Each new chat gets its own Turns over its own sprite.
    newTurns = function(sprite)
      return Turns.new{ Conversation = Conversation, clock = os.time, history = TurnHistory, capture = capture, sprite = sprite }
    end,
    setCaptureChat = function(chat) capture.chat = chat end,
    prompter = prompter,
    request = connection.request,
    isConnected = connection.isConnected,
    contextString = view.contextString,
    stateBlock = view.stateBlock,
    mentionTargets = view.Uri.targets,
    resolveUri = view.Uri.resolve,
    selectUri = view.Uri.select,
    savedCommands = saved,
    saveForRelaunch = function(conversation) saveForRelaunch(conversation) end,
    variations = handlers.variations,
    -- Project memory and checkpoints (#93).
    memory = load("project_memory.lua"),
    checkpoints = checkpoints,
    openCheckpoint = openCheckpoint,
    attachments = load("attachments.lua").new{
      dir = app.fs.joinPath(agentHome(), "attachments"),
      snapshot = handlers.snapshot, Uri = view.Uri,
      writeImage = function(img, path)
        app.fs.makeAllDirectories(app.fs.filePath(path))
        img:saveAs(path)
      end,
      clipboardImage = function()
        if not app.clipboard.hasImage then return nil end
        return app.clipboard.image
      end,
      clipboardHasImage = function() return app.clipboard.hasImage and not app.clipboard.hasText end,
      -- Image{ fromFile } drops an indexed file's palette, so those open as a
      -- sprite (closed right away) and frame 1 is rendered to RGB.
      readImage = function(path)
        local img = Image{ fromFile = path }
        if not img or img.colorMode == ColorMode.RGB then return img end
        local active = app.sprite
        local s = Sprite{ fromFile = path }
        local rgb = Image(s.width, s.height, ColorMode.RGB)
        rgb:drawSprite(s, 1)
        s:close()
        if active then app.sprite = active end
        return rgb
      end,
    },
    ensureBridge = connection.ensureBridge,
    preferences = plugin.preferences,
  }

  -- Scripting API for other scripts: AsepriteAgent.chat("make it blue")
  AsepriteAgent = {
    chat = function(prompt, provider, mode) Panel.submit(prompt, provider, mode) end,
    -- Answers every question with fn(question) -> button index (nil: ask as usual).
    setAnswers = function(fn) answers["*"] = fn end,
    -- Developer mode (#28) test hooks: fn("developer"), fn(status) or
    -- fn({ discard = true }) -> true to go ahead; nil clears them.
    setDeveloperAnswers = function(fn)
      answers.developer = fn and function() return fn("developer") and 1 or 0 end or nil
      answers.apply = fn and function(q) return fn(q.status) and 1 or 0 end or nil
      answers.discard = fn and function() return fn({ discard = true }) and 1 or 0 end or nil
    end,
    -- fn(request) -> option index for the agent's permission requests; nil clears it.
    setPermissionAnswer = function(fn) answers.permission = fn and function(q) return fn(q.request) end or nil end,
    -- Tests that answer permission dialogs turn asking on (off by default: requests are allowed automatically).
    setAskPermissions = function(on) plugin.preferences.askPermissions = on and true or false end,
    applyDevChanges = function() return Panel.applyDevChanges() end,
    discardDevChanges = function() return Panel.discardDevChanges() end,
    -- Runs a saved command like the menu does (#26).
    runCommand = function(name, args) return saved:run(name, args) end,
    savedCommands = function() return saved:load() end,
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
    busyChats = function() return Panel.busyChats() end,
    lastTurnView = function() return Panel.lastTurnView() end,
    placeholder = function() return Panel.placeholder() end,
    -- The / picker (#35): type into the prompt as the user would, read the matches.
    typePrompt = function(text) Panel.setPrompt(text); Panel.onPromptChange() end,
    suggestions = function() return Panel.suggestions() end,
    suggestionIndex = function() return Panel.suggestionIndex() end,
    pressKey = function(code, mods) return Panel.onPromptKey(code, mods) end,
    pickedSkill = function() return Panel.pickedSkill() end,
    pickSuggestion = function(i) Panel.pickSuggestion(Panel.suggestions()[i]) end,
    -- The last sub-agent scope highlighted in the timeline (#33).
    agentCursor = function() return handlers.agentCursor() end,
    entries = function() return Panel.entries() end,
    newChat = function() return Panel.newChat() end,
    openPanel = function() Panel.open() end,
    closePanel = function() Panel.close() end,
    isPanelOpen = function() return Panel.isOpen() end,
    promptText = function() return Panel.promptText() end,
    setPrompt = function(text) Panel.setPrompt(text) end,
    expandAll = function(state) Panel.expandAll(state) end,
    mention = function(name, uri) Panel.mention(name, uri) end,
    revertLast = function(force) return Panel.replyAction(nil, "revert", force) end,
    restoreLast = function() return Panel.replyAction(nil, "restore") end,
    -- Feeds a chat event to the panel as if the bridge sent it (tests).
    applyEvent = function(ev) Panel.onEvent(ev) end,
    -- Attach "selection" | "layer" | "frame", or { path = "ref.png" } (#21).
    attach = function(kind) return Panel.attach(kind) end,
    clearAttachments = function() Panel.clearAttachments() end,
    importAnimation = function(params) Panel.importAnimation(params) end,
    -- Chats of the active sprite (#3 per-sprite chats).
    chats = function() return Panel.chats() end,
    currentChat = function() return Panel.currentChat() end,
    showChat = function(id) return Panel.showChat(id) end,
    closeChat = function(id) return Panel.closeChat(id) end,
    queued = function() local q, paused = Panel.queued() return { items = q, paused = paused } end,
    sendNow = function(i) return Panel.sendNow(i) end,
    pendingAttachments = function() return Panel.pendingAttachments() end,
    -- The newest before/after capture of an edit request (#23).
    lastCapture = function()
      local c = capture:last()
      return c and { seq = c.seq, method = c.method, changed = c.changed, claimed = c.claimed or false } or nil
    end,
    stop = function() Panel.stop() end,
    -- #93: answer the newest style memory proposal (1 Remember, 2 Don't remember); rewind to the i-th user
    -- message of the chat on screen ("sprite" | "conversation" | "both" | "branch"); the sprite's style memory.
    answerMemory = function(index) return Panel.answerLastMemory(index) end,
    rewind = function(i, choice) return Panel.rewindUser(i, choice) end,
    styleMemory = function() return app.sprite and load("project_memory.lua").entries(app.sprite) or {} end,
    lastTurnStatus = function() return Panel.lastTurnStatus() end,
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

  -- Developer mode (#28): after a relaunch, reopen sprites and the conversation.
  local restored = restoreAfterRelaunch()
  if restored then Panel.restoreConversation(restored) end

  -- Saved commands (#26): My Commands submenu, filled from the folder.
  saved:reload()
  plugin:newCommand{
    id = "AgentManageCommands", title = "Manage My Commands...", group = "ai_agent_menu",
    onclick = function() Panel.manageCommands() end,
  }
  -- Off by default: the agent's permission requests are allowed without asking.
  plugin:newCommand{
    id = "AgentAskPermissions", title = "Ask Before Agent Actions", group = "ai_agent_menu",
    onchecked = function() return plugin.preferences.askPermissions == true end,
    onclick = function() plugin.preferences.askPermissions = not (plugin.preferences.askPermissions == true) end,
  }
  plugin:newCommand{
    id = "AgentCheckUpdates", title = "Check for Updates...", group = "ai_agent_menu",
    onclick = function() Panel.checkUpdates() end,
  }

  -- User skills (#27): ~/.aseprite-agent/skills/<name>.md
  local skillsDir = app.fs.joinPath(agentHome(), "skills")
  local function openPath(path, textEditor)
    if app.os.macos then os.execute(string.format('open %s"%s"', textEditor and "-t " or "", path))
    elseif app.os.windows then os.execute(string.format('start "" "%s"', path))
    else os.execute(string.format('xdg-open "%s"', path)) end
  end
  plugin:newMenuSeparator{ group = "ai_agent_menu" }
  plugin:newCommand{
    id = "AgentSkillsFolder", title = "Open Skills Folder", group = "ai_agent_menu",
    onclick = function()
      app.fs.makeAllDirectories(skillsDir)
      openPath(skillsDir)
    end,
  }
  plugin:newCommand{
    id = "AgentNewSkill", title = "New Skill...", group = "ai_agent_menu",
    onclick = function()
      local d = Dialog{ title = "New skill" }
      d:entry{ id = "name", label = "Name", text = "", focus = true }
      d:entry{ id = "triggers", label = "Trigger words", text = "" }
      d:label{ text = "Comma-separated words that bring this skill into a chat message." }
      d:button{ id = "ok", text = "&Create" }
      d:button{ id = "cancel", text = "&Cancel" }
      d:show()
      -- ASCII by range (%w follows the locale; /skill:<name> takes ASCII words).
      local name = (d.data.name or ""):lower():gsub("[^a-z0-9%-]+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
      if not d.data.ok or name == "" then return end
      app.fs.makeAllDirectories(skillsDir)
      local path = app.fs.joinPath(skillsDir, name .. ".md")
      if not app.fs.isFile(path) then
        local triggers = {}
        for w in (d.data.triggers or ""):gmatch("[^,]+") do triggers[#triggers + 1] = w:match("^%s*(.-)%s*$") end
        local f = assert(io.open(path, "w"))
        f:write(string.format("---\nname: %s\ndescription: One line on when to use this skill\ntriggers: [%s]\n---\n# %s\n\n" ..
          "Write your rules for the agent here: palette, outline style, how you like animations timed.\n" ..
          "Use it in the chat with /skill:%s, or just mention a trigger word.\n", name, table.concat(triggers, ", "), name, name))
        f:close()
      end
      openPath(path, true)
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
  attachCommand("AgentAttachClipboard", "Attach Clipboard Image to Chat", "ai_agent_menu", "clipboard")
  attachCommand("AgentAttachCel", "Attach to AI Chat", "cel_popup_properties", "layer")
  attachCommand("AgentAttachLayerPopup", "Attach to AI Chat", "layer_popup_properties", "layer")
  attachCommand("AgentAttachFramePopup", "Attach to AI Chat", "frame_popup_properties", "frame")

  if app.events then
    app.events:on("sitechange", function()
      -- Where the user left each sprite: a chat's requests on it default to that frame and layer (#90).
      handlers.noteSite()
      Panel.onSiteChange()
    end)
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
