-- Request params at the wire seam (#53): checks a request's params against
-- its schema in protocol.json and resolves layer and frame references once,
-- so handlers get layer ids and frame numbers in range. This is the only
-- check of a request's params (#96): the receiver checks, and the bridge
-- sends them as its tools' zod schemas left them. The type rules and error
-- messages are the same as the bridge's (agent/bridge/src/protocol.ts), which
-- checks what the extension sends it (bridge methods, get_state's result).

local M = {}

local function isList(v)
  return type(v) == "table" and (next(v) == nil or v[1] ~= nil)
end

-- Frame spec to a list of frame numbers (protocol.json "frames").
-- default: "all", "active" or nil (leave out).
function M.resolveFrames(spec, count, active, default)
  local out
  if spec == nil then
    if default == "all" then
      out = {}
      for i = 1, count do out[i] = i end
      return out
    elseif default == "active" then
      return { active }
    end
    return nil
  end
  if type(spec) == "number" then
    out = { spec }
  elseif isList(spec) then
    out = {}
    for i, f in ipairs(spec) do out[i] = tonumber(f) end
  elseif type(spec) == "string" and spec == "all" then
    out = {}
    for i = 1, count do out[i] = i end
  elseif type(spec) == "string" and spec:match("^%s*%d+%s*%-%s*%d+%s*$") then
    local a, b = spec:match("(%d+)%s*%-%s*(%d+)")
    out = {}
    for f = tonumber(a), tonumber(b) do out[#out + 1] = f end
  elseif type(spec) == "string" and spec:match("^%s*%d+%s*$") then
    out = { tonumber(spec) }
  else
    error("Frames must be a number, a list, 'a-b' or 'all' (got " .. tostring(spec) .. ")")
  end
  for _, f in ipairs(out) do
    if type(f) ~= "number" or f % 1 ~= 0 or f < 1 or f > count then
      error(string.format("Frame %s is out of range (1-%d)", tostring(f), count))
    end
  end
  return out
end

-- A bytes param (protocol.json binaryRequests): base64 text or { offset, length }.
function M.isBytes(v)
  if type(v) == "string" then return true end
  if type(v) ~= "table" then return false end
  for k in pairs(v) do if k ~= "offset" and k ~= "length" then return false end end
  return math.type(v.offset) == "integer" and math.type(v.length) == "integer" and v.offset >= 0 and v.length >= 0
end

-- The bytes of a bytes param: base64 text decoded, or a slice of blob (the
-- request's binary frame). decode is pixels.lua base64Decode.
function M.bytes(v, blob, decode)
  if type(v) == "string" then return decode(v) end
  if not M.isBytes(v) then error("Expected pixel bytes (base64 text or { offset, length })") end
  if not blob then error("The request refers to a binary frame it did not carry") end
  if v.offset + v.length > #blob then
    error(string.format("Bytes %d-%d are past the end of the binary frame (%d bytes)", v.offset, v.offset + v.length, #blob))
  end
  return blob:sub(v.offset + 1, v.offset + v.length)
end

local function isObject(v)
  return type(v) == "table" and v[1] == nil
end

local CHECK = {
  string = function(v) return type(v) == "string" end,
  integer = function(v) return math.type(v) == "integer" or (type(v) == "number" and v % 1 == 0) end,
  number = function(v) return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge end,
  boolean = function(v) return type(v) == "boolean" end,
  -- An empty table is both an empty list and an empty object (json.encode writes it as []).
  array = function(v) return isList(v) end,
  object = function(v) return isObject(v) end,
  any = function() return true end,
  layer = function(v) return type(v) == "string" or type(v) == "number" end,
  frame = function(v) return type(v) == "number" and v % 1 == 0 end,
  frames = function(v) return type(v) == "number" or type(v) == "string" or isList(v) end,
  -- Pixel bytes (#95): base64 text, or { offset, length } into the request's binary frame.
  bytes = function(v) return M.isBytes(v) end,
}

-- protocol.json types (params.types): a base type or shape name, [] (list of) and {} (map of) suffixes,
-- ? (optional), a default. "frames?all" -> { base = "frames", wrap = {}, optional = true, default = "all" };
-- "Layer[]?" -> { base = "Layer", wrap = { "[]" }, optional = true }. wrap is outermost first.
-- shapes: protocol.json shapes, to know shape names (nil: none).
function M.parseType(t, shapes)
  local base, suffix, opt, default = t:match("^(%a+)([%[%]{}]*)(%??)(%l*)$")
  if not base then error("protocol.json: malformed type '" .. tostring(t) .. "'") end
  if not CHECK[base] and not (shapes and shapes[base]) then error("protocol.json: unknown type '" .. base .. "'") end
  local wrap = {}
  for w in suffix:gmatch("[%[{][%]}]") do
    if w ~= "[]" and w ~= "{}" then error("protocol.json: malformed type '" .. t .. "'") end
    table.insert(wrap, 1, w)
  end
  if #suffix ~= 2 * #wrap then error("protocol.json: malformed type '" .. t .. "'") end
  return { base = base, wrap = wrap, optional = opt == "?", default = default ~= "" and default or nil }
end
local parseType = M.parseType

-- A shape's fields, with the fields of the shape it includes ("...": "Other").
function M.shapeFields(shapes, name)
  local shape = shapes and shapes[name]
  if not shape then error("protocol.json: unknown shape '" .. tostring(name) .. "'") end
  local out = {}
  if shape["..."] then
    for k, v in pairs(M.shapeFields(shapes, shape["..."])) do out[k] = v end
  end
  for k, v in pairs(shape) do if k ~= "..." then out[k] = v end end
  return out
end

local MAX_DEPTH = 32
local function describe(w, shapes)
  if w.wrap[1] == "[]" then return "an array" end
  if w.wrap[1] == "{}" then return "an object" end
  if shapes and shapes[w.base] then return "an object (" .. w.base .. ")" end
  if w.base == "frames" then return "a frame spec" end
  return (w.base:match("^[aeiouAEIOU]") and "an " or "a ") .. w.base
end

local checkFields

-- One value against a parsed type; path is the param path for messages ('attachments[0].path', 0-based like
-- the bridge's). The same rules and messages as the bridge's protocol.ts.
local function checkValue(where, path, w, v, shapes, depth)
  if depth > MAX_DEPTH then error(string.format("%s: '%s' is nested too deeply", where, path)) end
  local outer = w.wrap[1]
  local rest = { base = w.base, wrap = { table.unpack(w.wrap, 2) }, optional = w.optional }
  local function fail() error(string.format("%s: '%s' must be %s", where, path, describe(w, shapes)), 0) end
  if outer == "[]" then
    if not isList(v) then fail() end
    for i, x in ipairs(v) do checkValue(where, path .. "[" .. (i - 1) .. "]", rest, x, shapes, depth + 1) end
  elseif outer == "{}" then
    if not isObject(v) then fail() end
    for k, x in pairs(v) do checkValue(where, path .. "." .. tostring(k), rest, x, shapes, depth + 1) end
  elseif CHECK[w.base] then
    if not CHECK[w.base](v) then fail() end
  else
    if not isObject(v) then fail() end
    checkFields(where, M.shapeFields(shapes, w.base), v, path .. ".", false, shapes, depth + 1)
  end
end

-- Fields against name -> type: unknown fields (except scope, where allowed), missing required ones, types.
checkFields = function(where, fields, obj, prefix, allowScope, shapes, depth)
  for k in pairs(obj) do
    if fields[k] == nil and not (allowScope and k == "scope") then
      error(string.format("%s: unknown param '%s%s'", where, prefix, tostring(k)), 0)
    end
  end
  for name, t in pairs(fields) do
    local w = parseType(t, shapes)
    local v = obj[name]
    if v == nil then
      if not w.optional then error(string.format("%s: '%s%s' is required", where, prefix, name), 0) end
    else
      checkValue(where, prefix .. name, w, v, shapes, depth)
    end
  end
end

-- The params of a bridge method (protocol.json bridgeMethods) against their definition. The bridge checks them
-- on arrival (protocol.ts checkBridgeParams); the contract runner uses this to hold both to the same rules.
function M.checkBridgeParams(protocol, method, params)
  local spec = protocol.bridgeMethods and protocol.bridgeMethods[method]
  if not spec then error("Not a bridge method: " .. tostring(method)) end
  params = params or {}
  if type(params) ~= "table" or not isObject(params) then error(method .. ": params must be an object", 0) end
  checkFields(method, spec.params or {}, params, "", false, protocol.shapes, 0)
end

-- A request's result against its type in protocol.json (get_state: State). The bridge checks it on arrival
-- (protocol.ts checkResult); the contract runner and tests use this to keep the extension's results in shape.
function M.checkResult(protocol, method, result)
  local spec = protocol.requests[method]
  if spec and spec.result then
    checkValue(method .. " result", "result", parseType(spec.result, protocol.shapes), result, protocol.shapes, 0)
  end
end

-- Checks params against schema (name -> type) and returns them with layers
-- and frames resolved. ctx: { sprite, activeFrame, layerById }; shapes:
-- protocol.json shapes, for params of a shape type. This is the one check of a
-- request's params (#96): the bridge sends them unchecked.
function M.check(method, schema, params, ctx, shapes)
  params = params or {}
  checkFields(method, schema, params, "", true, shapes, 0)
  local sprite = ctx and ctx.sprite
  for name, t in pairs(schema) do
    local w = parseType(t, shapes)
    local v = params[name]
    if #w.wrap == 0 and w.base == "layer" and v ~= nil then
      if not sprite then error("No active sprite") end
      local layer = ctx.layerById(v, sprite)
      if not layer then error("Layer not found: " .. tostring(v)) end
      params[name] = "L" .. tostring(layer.id)
    elseif #w.wrap == 0 and w.base == "frame" and sprite then
      local count = #sprite.frames
      if v == nil then
        params[name] = ctx.activeFrame or 1
      elseif v < 1 or v > count then
        error(string.format("Frame %d is out of range (1-%d)", v, count))
      end
    elseif #w.wrap == 0 and w.base == "frames" and sprite then
      params[name] = M.resolveFrames(v, #sprite.frames, ctx.activeFrame or 1, w.default)
    end
  end
  return params
end

return M
