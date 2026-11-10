-- Headless runner (#85): one long-lived batch Aseprite for batch work.
--
--   aseprite -b --script-param ext=<agent/extension> --script headless_runner.lua
--
-- It answers the same requests as the live extension, with the same
-- Document Handlers and protocol.json (no second implementation), read as
-- JSON lines on stdin:
--
--   request  {"id": 1, "method": "snapshot", "params": {"frame": 1}}
--   reply    {"id": 1, "result": {...}, "binary": "<base64>"}  or  {"id": 1, "error": {"message": "..."}}
--
-- Every reply line starts with MARK, so a stray line Aseprite prints on
-- stdout is never read as a reply. Documents stay open between requests;
-- nothing is saved. Besides the protocol requests the runner answers
-- open {path}, close {path?} and shutdown. stdin closing also ends it.
--
-- Like agent.lua this is an entry script (run by `aseprite -b --script`,
-- never loaded by the plugin), so its file access is allowed by
-- tools/check_extension.mjs. The bridge side is agent/bridge/src/headless.ts.
-- Adapted from aseprite-ai-artist's headless/runner.lua (MIT).

local MARK = "\30ase "
local dir = app.params.ext or app.fs.filePath(debug.getinfo(1, "S").source:sub(2))

local function emit(payload)
  io.stdout:write(MARK .. json.encode(payload) .. "\n")
  -- stdout is a pipe, so block-buffered: without the flush a reply waits forever.
  io.stdout:flush()
end

local protocol = (function()
  local f = assert(io.open(app.fs.joinPath(dir, "protocol.json"), "r"), "protocol.json missing from " .. dir)
  local p = json.decode(f:read("a"))
  f:close()
  return p
end)()

local px = dofile(app.fs.joinPath(dir, "pixels.lua"))
local H = dofile(app.fs.joinPath(dir, "document_handlers.lua")).new{ chunkDir = dir, protocol = protocol }

local function spriteFor(path)
  if not path then return app.sprite end
  for _, s in ipairs(app.sprites) do
    if s.filename == path then return s end
  end
end

local function describe(s)
  return { filename = s.filename, width = s.width, height = s.height, frames = #s.frames, layers = #s.layers }
end

-- Requests only the runner answers (not in protocol.json).
local runner = {
  -- Opens a file (or makes it active when already open).
  open = function(params)
    local path = params.path
    if type(path) ~= "string" or path == "" then error("open needs a path") end
    local s = spriteFor(path) or app.open(path)
    if not s then error("Could not open " .. path) end
    app.sprite = s
    return describe(s)
  end,
  -- Closes the sprite with this path, or the active one. Nothing is saved.
  close = function(params)
    local s = spriteFor(params.path)
    if not s then error(params.path and ("Not open: " .. params.path) or "No active sprite") end
    s:close()
    return { closed = true, open = #app.sprites }
  end,
}

emit{ hello = { protocol = protocol.version, aseprite = tostring(app.version) } }

-- Each read blocks, which keeps the process and its documents alive between requests.
for line in io.stdin:lines() do
  if line ~= "" then
    local okDecode, msg = pcall(json.decode, line)
    local id = okDecode and type(msg) ~= "string" and msg.id or nil
    if id == nil then
      emit{ id = json.null, error = { message = "Bad request line (want {id, method, params})" } }
    else
      local method = msg.method
      if method == "shutdown" then
        emit{ id = id, result = { ok = true } }
        break
      end
      local ok, result, bytes = pcall(function()
        if runner[method] then return runner[method](msg.params or {}) end
        return H.call(method, msg.params or {})
      end)
      if not ok then
        local err = type(result) == "table" and result or { message = tostring(result) }
        emit{ id = id, error = { code = err.code, message = tostring(err.message) } }
      elseif bytes ~= nil then
        result.binary = true
        emit{ id = id, result = result, binary = px.base64Encode(bytes) }
      else
        emit{ id = id, result = result == nil and json.null or result }
      end
    end
  end
end
