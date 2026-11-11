-- Scope guard (#33): sub-agents started with spawn_agents may only edit
-- their scope (some frames, optionally some layers). Their edit requests
-- carry the scope; the guard compares everything outside it before and
-- after the step and undoes the step when something outside changed.
--
--   local Guard = dofile("scope_guard.lua")
--   local scope, err = Guard.resolve(sprite, { frames = "1-2", layers = { "L3" } }, layerById)
--   local before = Guard.snapshot(sprite, scope)
--   ... run the edit ...
--   local problem = Guard.check(sprite, scope, before)   -- nil or a sentence

local M = {}

-- "1-3", 2, { 1, 2 } or "1,3-4" -> set of frame numbers.
function M.parseFrames(spec, count)
  local set = {}
  local function add(a, b)
    for f = a, b do
      if f < 1 or f > count then return false end
      set[f] = true
    end
    return true
  end
  if type(spec) == "number" then
    if not add(spec, spec) then return nil end
  elseif type(spec) == "string" then
    for part in spec:gmatch("[^,%s]+") do
      local a, b = part:match("^(%d+)%-(%d+)$")
      a, b = tonumber(a or part), tonumber(b or part)
      if not a or not b or b < a or not add(a, b) then return nil end
    end
  elseif spec ~= nil then
    for _, f in ipairs(spec) do
      if not add(f, f) then return nil end
    end
  end
  return next(set) and set or nil
end

local function eachLayer(layers, fn)
  for _, l in ipairs(layers) do
    if l.isGroup then eachLayer(l.layers, fn) else fn(l) end
  end
end

-- Resolves a scope from a request: { frames = set, layers = set of layer ids or nil, label }.
function M.resolve(sprite, scope, layerById)
  if not sprite then return nil, "No active sprite" end
  local frames = M.parseFrames(scope.frames, #sprite.frames)
  if not frames then return nil, "The scope's frames are not valid for this sprite: " .. tostring(scope.frames) end
  local layers
  if scope.layers and #scope.layers > 0 then
    layers = {}
    for _, ref in ipairs(scope.layers) do
      local l = layerById(ref, sprite)
      if not l then return nil, "The scope names a layer that doesn't exist: " .. tostring(ref) end
      layers[l.id] = true
    end
  end
  return { frames = frames, layers = layers, label = scope.label, spec = scope }
end

local function inScope(scope, layer, frame)
  return scope.frames[frame] and (not scope.layers or scope.layers[layer.id])
end

-- Everything outside the scope that an edit must not change.
function M.snapshot(sprite, scope)
  local fp = { sprite = sprite, frames = #sprite.frames, layers = {}, cels = {}, durations = {} }
  eachLayer(sprite.layers, function(l)
    fp.layers[#fp.layers + 1] = l.id
    for f = 1, #sprite.frames do
      if not inScope(scope, l, f) then
        local c = l:cel(f)
        fp.cels[l.id .. ":" .. f] = c and string.format("%d.%d@%d,%d", c.image.id, c.image.version, c.position.x, c.position.y) or "-"
      end
    end
  end)
  for f = 1, #sprite.frames do
    if not scope.frames[f] then fp.durations[f] = sprite.frames[f].duration end
  end
  return fp
end

local function rangeText(set)
  local list = {}
  for f in pairs(set) do list[#list + 1] = f end
  table.sort(list)
  return table.concat(list, ",")
end

function M.describe(scope)
  return "frames " .. rangeText(scope.frames) .. (scope.layers and " of the scope's layers" or "")
end

-- nil when only the scope changed, otherwise what changed outside it. The
-- sprite need not be the active one (#90): a request that made or opened
-- another sprite is caught by the caller (document_handlers.lua, site.moved).
function M.check(sprite, scope, before)
  if #sprite.frames ~= before.frames then return "it changed the number of frames" end
  local now = {}
  eachLayer(sprite.layers, function(l) now[#now + 1] = l.id end)
  if #now ~= #before.layers then return "it added or removed layers" end
  for i, id in ipairs(now) do
    if before.layers[i] ~= id then return "it reordered layers" end
  end
  local problem
  eachLayer(sprite.layers, function(l)
    if problem then return end
    for f = 1, #sprite.frames do
      local key = l.id .. ":" .. f
      if before.cels[key] then
        local c = l:cel(f)
        local v = c and string.format("%d.%d@%d,%d", c.image.id, c.image.version, c.position.x, c.position.y) or "-"
        if v ~= before.cels[key] then
          problem = string.format("it changed %s (L%d) in frame %d", l.name, l.id, f)
          return
        end
      end
    end
  end)
  if problem then return problem end
  for f, d in pairs(before.durations) do
    if sprite.frames[f].duration ~= d then return "it changed the duration of frame " .. f end
  end
  return nil
end

return M
