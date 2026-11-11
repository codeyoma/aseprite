-- Motion stage gate (#99): while an animation is in its "keys" stage, an agent edit may change only the key frames
-- of its tag; the frames between them stay empty until motion_stage advances (after walk_check says ok). The stage
-- lives in the pixel spec (sprite property aseprite-agent "concept.spec", key "motion"), written by the bridge's
-- motion_stage tool. Every edit request goes through the gate, execute_lua included, so the keys can't be skipped.
--
--   local Gate = dofile("motion_gate.lua")
--   local gate = Gate.read(sprite)            -- nil, or { tag, keys, allowed = {frame=true}, describe }
--   local problem = Gate.check(sprite, gate, before)   -- with before = Gate.snapshot(sprite, gate)

local M = {}

-- The sprite's motion stage when it is "keys": its tag, the key frames, and the frames an edit may change (the keys
-- and every frame outside the tag). nil when there is no stage, or it is past the keys.
function M.read(sprite)
  if not sprite then return nil end
  local text = sprite.properties("aseprite-agent")["concept.spec"]
  if type(text) ~= "string" or text == "" then return nil end
  local ok, spec = pcall(json.decode, text)
  -- json.decode gives userdata objects (indexable, ipairs for arrays), not tables.
  local isObj = function(v) return type(v) == "table" or type(v) == "userdata" end
  if not ok or not isObj(spec) or not isObj(spec.motion) then return nil end
  local m = spec.motion
  if m.stage ~= "keys" then return nil end
  local tag
  for _, t in ipairs(sprite.tags) do
    if tostring(t.name):lower() == tostring(m.tag):lower() then tag = t end
  end
  if not tag then return nil end
  local keys, allowed = {}, {}
  for _, k in ipairs(m.keys or {}) do
    local f = math.floor(tonumber(k) or 0)
    if f >= 1 and f <= #sprite.frames then keys[#keys + 1] = f; allowed[f] = true end
  end
  local from, to = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
  for f = 1, #sprite.frames do
    if f < from or f > to then allowed[f] = true end
  end
  return { tag = tag.name, keys = keys, from = from, to = to, allowed = allowed }
end

-- The frames of the tag that may not change yet.
local function locked(sprite, gate)
  local out = {}
  for f = gate.from, math.min(gate.to, #sprite.frames) do
    if not gate.allowed[f] then out[#out + 1] = f end
  end
  return out
end

-- Every image cel of the locked frames: layer id, frame, position and bytes.
function M.snapshot(sprite, gate)
  local shot = {}
  local function walk(layers)
    for _, l in ipairs(layers) do
      if l.isGroup then walk(l.layers)
      elseif l.isImage then
        for _, f in ipairs(locked(sprite, gate)) do
          local cel = l:cel(f)
          shot[#shot + 1] = { layer = l, frame = f, cel = cel and (cel.position.x .. "," .. cel.position.y .. ":" .. cel.image.bytes) or false }
        end
      end
    end
  end
  walk(sprite.layers)
  shot.frames = #sprite.frames
  return shot
end

-- nil when no locked frame changed since the snapshot, else a sentence naming the first change.
function M.check(sprite, gate, before)
  -- Frames removed: the numbers moved, so nothing compares (a timeline edit, not a drawing). Frames added keep the
  -- locked frames' numbers when they go after them, so a script that adds frames and draws in one call is still checked.
  if #sprite.frames < before.frames then return nil end
  for _, e in ipairs(before) do
    local ok, cel = pcall(function() return e.layer:cel(e.frame) end)
    if ok then
      local now = cel and (cel.position.x .. "," .. cel.position.y .. ":" .. cel.image.bytes) or false
      if now ~= e.cel then return "frame " .. e.frame .. " (layer \"" .. e.layer.name .. "\") changed" end
    end
  end
  return nil
end

function M.describe(sprite, gate)
  local keys = {}
  for _, k in ipairs(gate.keys) do keys[#keys + 1] = tostring(k) end
  local l = {}
  for _, f in ipairs(locked(sprite, gate)) do l[#l + 1] = tostring(f) end
  return "Motion stage \"keys\" for tag \"" .. gate.tag .. "\": draw only the key frames (" .. table.concat(keys, ", ") ..
    ") until motion_stage advance (walk_check must say ok); frames " .. table.concat(l, ", ") .. " stay as they are."
end

return M
