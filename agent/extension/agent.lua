-- Aseprite Agent extension.
--
-- Connects to the local aseprite-agent bridge over WebSocket and executes
-- JSON-RPC requests sent by an AI coding agent (Claude Code, Codex).
--
-- The bridge writes its port and token to ~/.aseprite-agent/session.json.
-- This script reads that file, connects, authenticates, and then answers
-- requests. Every request runs on Aseprite's UI thread.

local PROTOCOL_VERSION = 1

local ws = nil
local session = nil      -- { port = n, token = s }
local connected = false
local reconnectTimer = nil
local pluginRef = nil

---------------------------------------------------------------------------
-- Utilities
---------------------------------------------------------------------------

local function homeDir()
  return os.getenv("HOME") or os.getenv("USERPROFILE") or "."
end

local function sessionPath()
  return app.fs.joinPath(homeDir(), ".aseprite-agent", "session.json")
end

local function readSession()
  local path = sessionPath()
  if not app.fs.isFile(path) then return nil end
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("a")
  f:close()
  local ok, obj = pcall(json.decode, text)
  if not ok or not obj or not obj.port or not obj.token then return nil end
  return { port = math.tointeger(obj.port), token = tostring(obj.token) }
end

local function colorToHex(c)
  if c.alpha == 255 then
    return string.format("#%02x%02x%02x", c.red, c.green, c.blue)
  end
  return string.format("#%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
end

local COLOR_MODES = {
  [ColorMode.RGB] = "rgb",
  [ColorMode.GRAYSCALE] = "grayscale",
  [ColorMode.INDEXED] = "indexed",
}
if ColorMode.TILEMAP then COLOR_MODES[ColorMode.TILEMAP] = "tilemap" end

local ANI_DIRS = {
  [AniDir.FORWARD] = "forward",
  [AniDir.REVERSE] = "reverse",
  [AniDir.PING_PONG] = "ping-pong",
}
if AniDir.PING_PONG_REVERSE then ANI_DIRS[AniDir.PING_PONG_REVERSE] = "ping-pong-reverse" end

local function typeName(v)
  local mt = getmetatable(v)
  return mt and mt.__name or type(v)
end

-- Convert any Lua value into something json.encode accepts.
local function toPlain(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "nil" or t == "boolean" or t == "string" then return v end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return tostring(v) end
    return v
  end
  if depth > 6 then return tostring(v) end
  if t == "table" then
    local out = {}
    for k, val in pairs(v) do
      out[type(k) == "number" and k or tostring(k)] = toPlain(val, depth + 1)
    end
    return out
  end
  if t == "userdata" then
    local name = typeName(v)
    if name == "Color" then return colorToHex(v) end
    if name == "Point" then return { x = v.x, y = v.y } end
    if name == "Size" then return { width = v.width, height = v.height } end
    if name == "Rectangle" then return { x = v.x, y = v.y, width = v.width, height = v.height } end
    if name == "Layer" then return { layer = v.name } end
    if name == "Frame" then return { frame = v.frameNumber } end
    if name == "Tag" then return { tag = v.name } end
    if name == "Sprite" then return { sprite = v.filename } end
    return tostring(v)
  end
  return tostring(v)
end

---------------------------------------------------------------------------
-- Document description
---------------------------------------------------------------------------

-- "Group/Sub/Layer" path of a layer, for nested groups.
local function layerPath(layer)
  local parts = { layer.name }
  local p = layer.parent
  while p and typeName(p) == "Layer" do
    table.insert(parts, 1, p.name)
    p = p.parent
  end
  return table.concat(parts, "/")
end

local function describeLayers(layers)
  local out = {}
  -- Top-most layer first, as in the timeline.
  for i = #layers, 1, -1 do
    local l = layers[i]
    local item = {
      name = l.name,
      stackIndex = l.stackIndex,
      visible = l.isVisible,
      editable = l.isEditable,
      group = l.isGroup,
    }
    if l.isGroup then
      item.layers = describeLayers(l.layers)
    else
      item.opacity = l.opacity
      item.tilemap = l.isTilemap or nil
      item.background = l.isBackground or nil
      item.reference = l.isReference or nil
      local cels = {}
      for _, cel in ipairs(l.cels) do
        cels[#cels + 1] = cel.frameNumber
      end
      item.celFrames = cels
    end
    out[#out + 1] = item
  end
  return out
end

local function describeSprite(sprite, full)
  local info = {
    filename = sprite.filename,
    width = sprite.width,
    height = sprite.height,
    colorMode = COLOR_MODES[sprite.colorMode] or tostring(sprite.colorMode),
    frameCount = #sprite.frames,
    layerCount = #sprite.layers,
    modified = sprite.isModified,
  }
  if not full then return info end

  info.layers = describeLayers(sprite.layers)

  local frames = {}
  for i, f in ipairs(sprite.frames) do
    frames[i] = { frame = i, durationMs = math.floor(f.duration * 1000 + 0.5) }
  end
  info.frames = frames

  local tags = {}
  for _, t in ipairs(sprite.tags) do
    tags[#tags + 1] = {
      name = t.name,
      from = t.fromFrame.frameNumber,
      to = t.toFrame.frameNumber,
      direction = ANI_DIRS[t.aniDir] or tostring(t.aniDir),
      ["repeat"] = t.repeats,
    }
  end
  info.tags = tags

  local pal = sprite.palettes[1]
  local colors = {}
  local limit = math.min(#pal, 256)
  for i = 0, limit - 1 do
    colors[#colors + 1] = colorToHex(pal:getColor(i))
  end
  info.palette = { size = #pal, colors = colors }

  local sel = sprite.selection
  if sel and not sel.isEmpty then
    local b = sel.bounds
    info.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  return info
end

local function getState()
  local sprites = {}
  for _, s in ipairs(app.sprites) do
    sprites[#sprites + 1] = describeSprite(s, false)
  end

  local state = {
    asepriteVersion = tostring(app.version),
    apiVersion = app.apiVersion,
    openSprites = sprites,
    tool = app.tool and app.tool.id or nil,
    fgColor = colorToHex(app.fgColor),
    bgColor = colorToHex(app.bgColor),
  }

  local sprite = app.sprite
  if sprite then
    state.activeSprite = describeSprite(sprite, true)
    state.activeLayer = app.layer and layerPath(app.layer) or nil
    state.activeFrame = app.frame and app.frame.frameNumber or nil
  end
  return state
end

---------------------------------------------------------------------------
-- Snapshot
---------------------------------------------------------------------------

-- Convert a cel image of any color mode to an RGB image, using the palette.
local function toRgbImage(src, palette)
  if src.colorMode == ColorMode.RGB then return src end
  local dst = Image(src.width, src.height, ColorMode.RGB)
  if src.colorMode == ColorMode.INDEXED then
    local mask = src.spec.transparentColor
    for it in src:pixels() do
      local idx = it()
      if idx ~= mask and idx < #palette then
        local c = palette:getColor(idx)
        dst:drawPixel(it.x, it.y, app.pixelColor.rgba(c.red, c.green, c.blue, c.alpha))
      end
    end
  elseif src.colorMode == ColorMode.GRAYSCALE then
    local pc = app.pixelColor
    for it in src:pixels() do
      local v = it()
      local g, a = pc.grayaV(v), pc.grayaA(v)
      dst:drawPixel(it.x, it.y, pc.rgba(g, g, g, a))
    end
  end
  return dst
end

local function findLayer(layers, name)
  for _, l in ipairs(layers) do
    if l.name == name then return l end
    if l.isGroup then
      local found = findLayer(l.layers, name)
      if found then return found end
    end
  end
  return nil
end

-- Returns header table and raw RGBA bytes.
local function snapshot(params)
  local sprite = app.sprite
  if not sprite then error("No active sprite") end

  local frameNumber = params.frame or (app.frame and app.frame.frameNumber) or 1
  if frameNumber < 1 or frameNumber > #sprite.frames then
    error("Frame " .. frameNumber .. " is out of range (1-" .. #sprite.frames .. ")")
  end

  local img = Image(sprite.width, sprite.height, ColorMode.RGB)

  if params.layer then
    local layer = findLayer(sprite.layers, params.layer)
    if not layer then error("Layer not found: " .. params.layer) end
    if layer.isGroup then error("Snapshot of a group layer is not supported; snapshot the sprite instead") end
    local cel = layer:cel(frameNumber)
    if cel then
      local rgb = toRgbImage(cel.image, sprite.palettes[1])
      img:drawImage(rgb, cel.position)
    end
  else
    img:drawSprite(sprite, frameNumber)
  end

  return {
    width = img.width,
    height = img.height,
    frame = frameNumber,
    layer = params.layer,
  }, img.bytes
end

---------------------------------------------------------------------------
-- execute_lua
---------------------------------------------------------------------------

local function executeLua(params)
  local code = params.code
  if type(code) ~= "string" then error("params.code must be a string") end

  local output = {}
  local function capturePrint(...)
    local parts = {}
    for i = 1, select("#", ...) do
      parts[#parts + 1] = tostring((select(i, ...)))
    end
    output[#output + 1] = table.concat(parts, "\t")
  end

  local env = setmetatable({ print = capturePrint }, { __index = _G })

  -- A distinct chunk name gives agent code its own entry in Aseprite's
  -- script-access permissions, separate from this extension's trust.
  local chunkName = "@" .. app.fs.joinPath(pluginRef.path, "agent_exec.lua")
  local fn, compileErr = load(code, chunkName, "t", env)
  if not fn then
    return { ok = false, error = "Compile error: " .. tostring(compileErr), output = output }
  end

  local results
  local function run()
    -- Capture the traceback here, then rethrow so a transaction rolls back.
    local packed = table.pack(xpcall(fn, debug.traceback))
    if not packed[1] then error(packed[2], 0) end
    results = table.pack(table.unpack(packed, 2, packed.n))
  end

  -- app.transaction needs an active document; without one (e.g. code that
  -- creates the first sprite) run the code directly.
  local useTransaction = params.transaction ~= false and app.sprite ~= nil

  local ok, err
  if useTransaction then
    local label = params.label or "AI Agent"
    -- An error inside app.transaction rolls the whole step back.
    ok, err = pcall(app.transaction, label, run)
  else
    ok, err = pcall(run)
  end
  app.refresh()

  if not ok then
    return { ok = false, error = tostring(err), output = output, rolledBack = useTransaction }
  end

  local value
  if results and results.n > 0 then
    if results.n == 1 then
      value = toPlain(results[1])
    else
      value = {}
      for i = 1, results.n do value[i] = toPlain(results[i]) end
    end
  end
  return { ok = true, value = value, output = output }
end

---------------------------------------------------------------------------
-- Request dispatch
---------------------------------------------------------------------------

local function send(obj)
  if ws then ws:sendText(json.encode(obj)) end
end

local handlers = {}

handlers.ping = function()
  return { pong = true, asepriteVersion = tostring(app.version), protocol = PROTOCOL_VERSION }
end

handlers.get_state = function()
  return getState()
end

handlers.execute_lua = function(params)
  return executeLua(params)
end

handlers.undo = function(params)
  local n = params.steps or 1
  for _ = 1, n do app.undo() end
  app.refresh()
  return { undone = n }
end

handlers.redo = function(params)
  local n = params.steps or 1
  for _ = 1, n do app.redo() end
  app.refresh()
  return { redone = n }
end

local function handleRequest(msg)
  local id = msg.id
  local method = msg.method
  local params = msg.params or {}

  if method == "snapshot" then
    local ok, header, bytes = pcall(snapshot, params)
    if ok then
      header.binary = true
      send({ jsonrpc = "2.0", id = id, result = header })
      ws:sendBinary(bytes)
    else
      send({ jsonrpc = "2.0", id = id, error = { code = -32000, message = tostring(header) } })
    end
    return
  end

  local handler = handlers[method]
  if not handler then
    send({ jsonrpc = "2.0", id = id, error = { code = -32601, message = "Unknown method: " .. tostring(method) } })
    return
  end

  local ok, result = xpcall(handler, debug.traceback, params)
  if ok then
    send({ jsonrpc = "2.0", id = id, result = result })
  else
    send({ jsonrpc = "2.0", id = id, error = { code = -32000, message = tostring(result) } })
  end
end

---------------------------------------------------------------------------
-- Connection
---------------------------------------------------------------------------

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

-- When the bridge restarts it picks a new port and token, so poll the
-- session file and reconnect when it changes.
local function startReconnectTimer()
  if reconnectTimer then return end
  reconnectTimer = Timer{
    interval = 2.0,
    ontick = function()
      if connected then return end
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
      protocol = PROTOCOL_VERSION,
      asepriteVersion = tostring(app.version),
    } })
  elseif mt == WebSocketMessageType.TEXT then
    local ok, msg = pcall(json.decode, data)
    if not ok or type(msg) ~= "table" and type(msg) ~= "userdata" then return end
    if msg.method == "welcome" then
      connected = true
      app.tip("AI Agent connected")
    elseif msg.method then
      handleRequest(msg)
    end
  elseif mt == WebSocketMessageType.CLOSE or mt == WebSocketMessageType.ERROR then
    if connected then app.tip("AI Agent disconnected") end
    connected = false
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

  ws = WebSocket{
    url = "ws://127.0.0.1:" .. session.port,
    onreceive = onReceive,
    deflate = false,
    minreconnectwait = 1,
    maxreconnectwait = 5,
  }
  ws:connect()
  startReconnectTimer()
end

---------------------------------------------------------------------------
-- Plugin entry points
---------------------------------------------------------------------------

function init(plugin)
  pluginRef = plugin

  plugin:newMenuGroup{
    id = "ai_agent_menu",
    title = "AI Agent",
    group = "file_scripts",
  }

  plugin:newCommand{
    id = "AgentConnect",
    title = "Connect",
    group = "ai_agent_menu",
    onclick = function()
      plugin.preferences.autoconnect = true
      connect(false)
    end,
  }

  plugin:newCommand{
    id = "AgentDisconnect",
    title = "Disconnect",
    group = "ai_agent_menu",
    onclick = function()
      plugin.preferences.autoconnect = false
      disconnect()
      app.tip("AI Agent disconnected")
    end,
  }

  -- Auto-connect by default; the menu's Disconnect turns it off.
  if plugin.preferences.autoconnect ~= false then
    connect(true)
  end
end

function exit(plugin)
  disconnect()
end

-- Expose internals to the batch-mode test harness (agent/tests).
if os.getenv("ASEPRITE_AGENT_TEST") then
  _G.__aseprite_agent = {
    getState = getState,
    executeLua = executeLua,
    snapshot = snapshot,
    handlers = handlers,
  }
end
