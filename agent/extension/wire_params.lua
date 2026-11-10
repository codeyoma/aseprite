-- Request params at the wire seam (#53): checks a request's params against
-- its schema in protocol.json and resolves layer and frame references once,
-- so handlers get layer ids and frame numbers in range. The bridge checks
-- the same schema before sending (agent/bridge/src/protocol.ts).

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

local CHECK = {
  string = function(v) return type(v) == "string" end,
  integer = function(v) return type(v) == "number" and v % 1 == 0 end,
  number = function(v) return type(v) == "number" end,
  boolean = function(v) return type(v) == "boolean" end,
  array = function(v) return isList(v) end,
  object = function(v) return type(v) == "table" and not (v[1] ~= nil) end,
  any = function() return true end,
  layer = function(v) return type(v) == "string" or type(v) == "number" end,
  frame = function(v) return type(v) == "number" and v % 1 == 0 end,
  frames = function(v) return type(v) == "number" or type(v) == "string" or isList(v) end,
}

-- "frames?all" -> "frames", true, "all"
local function parseType(t)
  local base, opt, default = t:match("^(%a+)(%??)(%a*)$")
  return base, opt == "?", default ~= "" and default or nil
end

-- Checks params against schema (name -> type) and returns them with layers
-- and frames resolved. ctx: { sprite, activeFrame, layerById }.
function M.check(method, schema, params, ctx)
  params = params or {}
  for k in pairs(params) do
    if schema[k] == nil and k ~= "scope" then
      error(string.format("%s: unknown param '%s'", method, tostring(k)))
    end
  end
  for name, t in pairs(schema) do
    local base, optional, default = parseType(t)
    local v = params[name]
    if v == nil then
      if not optional then error(string.format("%s: '%s' is required", method, name)) end
    elseif not CHECK[base] then
      error(string.format("%s: unknown type '%s' in protocol.json", method, t))
    elseif not CHECK[base](v) then
      error(string.format("%s: '%s' must be %s", method, name, base == "frames" and "a frame spec" or ("a " .. base)))
    end
    local sprite = ctx and ctx.sprite
    if base == "layer" and v ~= nil then
      if not sprite then error("No active sprite") end
      local layer = ctx.layerById(v, sprite)
      if not layer then error("Layer not found: " .. tostring(v)) end
      params[name] = "L" .. tostring(layer.id)
    elseif base == "frame" and sprite then
      local count = #sprite.frames
      if v == nil then
        params[name] = ctx.activeFrame or 1
      elseif v < 1 or v > count then
        error(string.format("Frame %d is out of range (1-%d)", v, count))
      end
    elseif base == "frames" and sprite then
      params[name] = M.resolveFrames(v, #sprite.frames, ctx.activeFrame or 1, default)
    end
  end
  return params
end

return M
