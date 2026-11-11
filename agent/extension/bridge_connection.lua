-- Bridge Connection: finds the newest bridge through the session file,
-- connects over WebSocket, does the hello/welcome handshake, reconnects
-- when bridges change, and routes messages. It knows nothing about
-- documents: requests go to opts.onRequest.
--
--   local BridgeConnection = dofile("bridge_connection.lua")
--   local conn = BridgeConnection.new{
--     protocol = P, preferences = plugin.preferences,
--     onRequest = function(method, params) return result, bytes end,  -- may error
--     onNotification = function(method, params) end,                  -- e.g. chat.event
--     onConnectionChange = function(connected) end,
--     gate = function(method) return true | "hold" | "error message" end,  -- optional; for origin "chat"
--     readFile = function(path) return text end,   -- file and shell access go through
--     runShell = function(command) end,             -- the plugin's trusted script
--     openSocket = function(args) return WebSocket(args) end,
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
local function homeDir()
  return os.getenv("HOME") or os.getenv("USERPROFILE") or "."
end

local function sessionPath()
  return app.fs.joinPath(homeDir(), ".aseprite-agent", "session.json")
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
  -- the data as a binary frame when onRequest returns bytes.
  local function handleRequest(msg)
    local id = msg.id
    local ok, result, bytes = xpcall(onRequest, debug.traceback, msg.method, msg.params or {}, msg.origin)
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

local function onReceive(mt, data, err)
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
      -- Only a chat turn's requests (origin "chat") wait; held ones keep their order.
      local g = true
      if msg.origin == "chat" then g = (#held == 0) and gate(msg.method) or "hold" end
      if g == true then handleRequest(msg)
      elseif g == "hold" then held[#held + 1] = msg
      else send({ jsonrpc = "2.0", id = msg.id, error = { code = -32000, message = tostring(g) } }) end
    elseif type(msg.id) == "string" and pendingLocal[msg.id] then
      local cb = pendingLocal[msg.id]
      pendingLocal[msg.id] = nil
      cb(msg.result, msg.error)
    end
  elseif mt == WebSocketMessageType.CLOSE or mt == WebSocketMessageType.ERROR then
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
    local bridgePath = preferences.bridgePath
    if not bridgePath or not app.fs.isFile(bridgePath) then
      return callback(false, "No bridge found. Run `claude` (or Codex) once with the aseprite MCP server so Aseprite learns where the bridge is.")
    end
    local logFile = app.fs.joinPath(homeDir(), ".aseprite-agent", "daemon.log")
    -- A login shell gives the bridge the user's PATH (node, claude, codex).
    local inner = "nohup node " .. shellQuote(bridgePath) .. " --daemon > " .. shellQuote(logFile) .. " 2>&1 &"
    runShell("/bin/zsh -lc " .. shellQuote(inner))
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
        callback(false, "The bridge did not start. See ~/.aseprite-agent/daemon.log")
      elseif waited % 2 == 0 and not ws then
        connect(true)
      end
    end,
  }
  timer:start()
end

  local function retryHeld()
    while #held > 0 do
      local g = gate(held[1].method)
      if g == "hold" then return end
      local msg = table.remove(held, 1)
      if g == true then handleRequest(msg)
      else send({ jsonrpc = "2.0", id = msg.id, error = { code = -32000, message = tostring(g) } }) end
    end
  end

  local function failHeld(message)
    for _, msg in ipairs(held) do send({ jsonrpc = "2.0", id = msg.id, error = { code = -32000, message = message } }) end
    held = {}
  end

  return {
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
