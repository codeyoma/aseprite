-- Bridge Connection: finds the newest bridge through the session file,
-- connects over WebSocket, does the hello/welcome handshake, reconnects
-- when bridges change, and routes messages. It knows nothing about
-- documents: requests go to opts.onRequest.
--
--   local BridgeConnection = dofile("bridge_connection.lua")
--   local conn = BridgeConnection.new{
--     protocol = P, preferences = plugin.preferences,
--     onRequest = function(method, params, origin, chat, blob) return result, bytes end,  -- may error; blob: the request's binary frame
--     onNotification = function(method, params) end,                  -- e.g. chat.event
--     onConnectionChange = function(connected) end,
--     gate = function(method) return true | "hold" | "error message" end,  -- optional; for origin "chat"
--     readFile = function(path) return text end,   -- file and shell access go through
--     runShell = function(command) end,             -- the plugin's trusted script
--     openSocket = function(args) return WebSocket(args) end,
--     sessionPath = "<file>",                       -- optional (tests); default <agent home>/session.json
--   }
--   conn.connect(true); conn.request("chat.send", {...}, callback)
--   conn.retryHeld()           -- runs held requests the gate now lets through
--   conn.failHeld("message")   -- answers every held request with an error

local M = {}

function M.new(opts)
  local PROTOCOL = assert(opts.protocol, "protocol required")
  local preferences = opts.preferences or {}
  local onRequest = assert(opts.onRequest, "onRequest required")
  local onNotification = opts.onNotification or function() end
  -- The gate holds requests while they can't run yet (the running chat's
  -- sprite is not the active one); held requests run in order later.
  local gate = opts.gate or function() return true end
  local held = {}
  local onConnectionChange = opts.onConnectionChange or function() end
  -- Aseprite asks permission per script file for io/os calls, so they are
  -- done by agent.lua (already trusted) instead of this module.
  local readFile = assert(opts.readFile, "readFile required")
  local runShell = assert(opts.runShell, "runShell required")
  local openSocket = assert(opts.openSocket, "openSocket required")

local ws = nil
local session = nil      -- { port = n, token = s }
local connected = false
local reconnectTimer = nil
-- The agent's folder: the same rule as agent.lua agentHome().
local function agentHome()
  return os.getenv("ASEPRITE_AGENT_HOME")
    or app.fs.joinPath(os.getenv("HOME") or os.getenv("USERPROFILE") or app.fs.userConfigPath, ".aseprite-agent")
end

local function sessionPath()
  -- opts.sessionPath: tests use their own file, never the user's.
  if opts.sessionPath then return opts.sessionPath end
  return app.fs.joinPath(agentHome(), "session.json")
end

local function readSession()
  local path = sessionPath()
  if not app.fs.isFile(path) then return nil end
  local text = readFile(path)
  if not text then return nil end
  local ok, obj = pcall(json.decode, text)
  if not ok or not obj or not obj.port or not obj.token then return nil end
  if obj.bridgePath then
    -- Remember where the bridge lives so the chat panel can start it later.
    preferences.bridgePath = tostring(obj.bridgePath)
  end
  return { port = math.tointeger(obj.port), token = tostring(obj.token) }
end

-- Sends a message to the bridge. The socket can close at any time (bridge
-- restart, handover); a failed send is dropped, not raised.
local function send(obj)
  if not ws then return false end
  return (pcall(ws.sendText, ws, json.encode(obj)))
end

local function sendBinary(bytes)
  if not ws then return false end
  return (pcall(ws.sendBinary, ws, bytes))
end

-- Requests this extension sends to the bridge (chat). String ids keep them
-- apart from the bridge's numeric request ids.
local pendingLocal = {}
local nextLocalId = 1
local function requestBridge(method, params, callback)
  if not connected then
    if callback then callback(nil, { message = "Bridge not connected" }) end
    return
  end
  local id = "x" .. nextLocalId
  nextLocalId = nextLocalId + 1
  pendingLocal[id] = callback or function() end
  send({ jsonrpc = "2.0", id = id, method = method, params = params or {} })
end

  -- Answers one request from the bridge with the result of onRequest, and
  -- the data as a binary frame when onRequest returns bytes. blob: the
  -- request's own binary frame (#95), passed on to onRequest.
  local function handleRequest(msg, blob)
    local id = msg.id
    local ok, result, bytes = xpcall(onRequest, debug.traceback, msg.method, msg.params or {}, msg.origin, msg.chat, blob)
    if not ok then
      local err = type(result) == "table" and result or { code = -32000, message = tostring(result) }
      send({ jsonrpc = "2.0", id = id, error = err })
    elseif bytes ~= nil then
      result.binary = true
      if send({ jsonrpc = "2.0", id = id, result = result }) then sendBinary(bytes) end
    else
      send({ jsonrpc = "2.0", id = id, result = result })
    end
  end

local function stopReconnectTimer()
  if reconnectTimer then
    reconnectTimer:stop()
    reconnectTimer = nil
  end
end

local function disconnect()
  stopReconnectTimer()
  if ws then
    ws:close()
    ws = nil
  end
  connected = false
end

local connect

-- Bridges pick a new port and token each time they start, so poll the
-- session file and reconnect when it changes.
local function startReconnectTimer()
  if reconnectTimer then return end
  reconnectTimer = Timer{
    interval = 2.0,
    ontick = function()
      -- The newest bridge owns the session file. Follow it even while
      -- connected, so a new agent session takes over Aseprite.
      local s = readSession()
      if s and (not session or s.port ~= session.port or s.token ~= session.token) then
        connect(true)
      end
    end,
  }
  reconnectTimer:start()
end

-- A request with binary: <length> waits here for the binary frame that
-- follows it (#95, protocol.json binaryRequests).
local awaiting = nil

local function replyError(msg, message)
  send({ jsonrpc = "2.0", id = msg.id, error = { code = -32000, message = message } })
end

-- Runs a request from the bridge (with its binary frame, if any), or holds
-- it: only a chat turn's requests (origin "chat") wait; held ones keep their order.
local function dispatch(msg, blob)
  local g = true
  if msg.origin == "chat" then g = (#held == 0) and gate(msg.method) or "hold" end
  if g == true then handleRequest(msg, blob)
  elseif g == "hold" then held[#held + 1] = { msg = msg, blob = blob }
  else replyError(msg, tostring(g)) end
end

local function onReceive(mt, data, err)
  if mt == WebSocketMessageType.BINARY then
    local msg = awaiting
    awaiting = nil
    if not msg then return end
    if #data ~= msg.binary then
      replyError(msg, string.format("The binary frame has %d bytes, the request said %d", #data, msg.binary))
    else
      dispatch(msg, data)
    end
    return
  end
  if awaiting and mt == WebSocketMessageType.TEXT then
    -- The frame never came: answer the request instead of running it without its bytes.
    replyError(awaiting, "The request's binary frame did not arrive")
    awaiting = nil
  end
  if mt == WebSocketMessageType.OPEN then
    send({ jsonrpc = "2.0", method = "hello", params = {
      token = session.token,
      protocol = PROTOCOL.version,
      asepriteVersion = tostring(app.version),
    } })
  elseif mt == WebSocketMessageType.TEXT then
    local ok, msg = pcall(json.decode, data)
    if not ok or type(msg) ~= "table" and type(msg) ~= "userdata" then return end
    if msg.method == "incompatible" then
      -- Wrong protocol version: stay away from this bridge (same session
      -- token) until a different one is published, and say why once.
      if ws then ws:close(); ws = nil end
      connected = false
      local text = msg.params and msg.params.message or "The bridge speaks a different protocol version."
      app.alert{ title = "AI Agent", text = text }
      startReconnectTimer()
    elseif msg.method == "welcome" then
      connected = true
      app.tip("AI Agent connected")
      onConnectionChange(true)
    elseif msg.method and msg.id == nil then
      onNotification(msg.method, msg.params)
    elseif msg.method then
      if type(msg.binary) == "number" and msg.binary % 1 == 0 and msg.binary >= 0 then
        msg = { id = msg.id, method = msg.method, params = msg.params, origin = msg.origin, chat = msg.chat,
                binary = math.tointeger(msg.binary) }
        awaiting = msg
      else
        dispatch(msg, nil)
      end
    elseif type(msg.id) == "string" and pendingLocal[msg.id] then
      local cb = pendingLocal[msg.id]
      pendingLocal[msg.id] = nil
      cb(msg.result, msg.error)
    end
  elseif mt == WebSocketMessageType.CLOSE or mt == WebSocketMessageType.ERROR then
    awaiting = nil
    if connected then
      app.tip("AI Agent disconnected")
      onConnectionChange(false)
    end
    connected = false
    for id, cb in pairs(pendingLocal) do
      pendingLocal[id] = nil
      cb(nil, { message = "Bridge disconnected" })
    end
  end
end

connect = function(quiet)
  disconnect()
  session = readSession()
  if not session then
    if not quiet then
      app.alert{
        title = "AI Agent",
        text = {
          "The aseprite-agent bridge is not running.",
          "Start Claude Code or Codex with the aseprite-agent MCP server,",
          "then try again. Expected: " .. sessionPath(),
        },
      }
    end
    startReconnectTimer()
    return
  end

  ws = openSocket{
    url = "ws://127.0.0.1:" .. session.port,
    onreceive = onReceive,
    deflate = false,
    minreconnectwait = 1,
    maxreconnectwait = 5,
  }
  ws:connect()
  startReconnectTimer()
end

local function shellQuote(s)
  return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

-- Make sure a bridge is connected; start a background bridge if none runs.
local function ensureBridge(callback)
  if connected then return callback(true) end

  if not readSession() then
    -- The instance's own bridge: <agent home>/bridge.json (the stable
    -- installer writes it; every bridge records itself there), else the
    -- last one seen in a session file.
    local bridgePath
    local recorded = readFile(app.fs.joinPath(agentHome(), "bridge.json"))
    local okJson, info = pcall(json.decode, recorded or "")
    -- json.decode gives a userdata object, not a table.
    if okJson and info ~= nil and type(info) ~= "string" and info.bridgePath and app.fs.isFile(tostring(info.bridgePath)) then bridgePath = tostring(info.bridgePath) end
    bridgePath = bridgePath or preferences.bridgePath
    if not bridgePath or not app.fs.isFile(bridgePath) then
      return callback(false, "No bridge found. Run `claude` (or Codex) once with the aseprite MCP server so Aseprite learns where the bridge is.")
    end
    -- The daemon writes <agent home>/daemon.log itself.
    if app.os.windows then
      -- cmd.exe: start detached, without a console window, with Aseprite's PATH.
      runShell('start "" /B node "' .. bridgePath:gsub('"', '') .. '" --daemon')
    else
      -- A login shell gives the bridge the user's PATH (node, claude, codex).
      runShell("/bin/zsh -lc " .. shellQuote("nohup node " .. shellQuote(bridgePath) .. " --daemon > /dev/null 2>&1 &"))
    end
  end
  connect(true)

  local waited = 0
  local timer
  timer = Timer{
    interval = 0.25,
    ontick = function()
      waited = waited + 0.25
      if connected then
        timer:stop()
        callback(true)
      elseif waited >= 15 then
        timer:stop()
        callback(false, "The bridge did not start. See " .. app.fs.joinPath(agentHome(), "daemon.log"))
      elseif waited % 2 == 0 and not ws then
        connect(true)
      end
    end,
  }
  timer:start()
end

  local function retryHeld()
    while #held > 0 do
      local g = gate(held[1].msg.method)
      if g == "hold" then return end
      local h = table.remove(held, 1)
      if g == true then handleRequest(h.msg, h.blob)
      else replyError(h.msg, tostring(g)) end
    end
  end

  local function failHeld(message)
    for _, h in ipairs(held) do replyError(h.msg, message) end
    held = {}
  end

  return {
    -- For tests: feed a message as the WebSocket would (type, data).
    receive = function(mt, data) onReceive(mt, data, "") end,
    retryHeld = retryHeld,
    failHeld = failHeld,
    connect = connect,
    disconnect = disconnect,
    isConnected = function() return connected end,
    request = requestBridge,
    ensureBridge = ensureBridge,
    sessionPath = sessionPath,
  }
end

return M
