-- Motion stage gate (#99, #109): while an animation's clip is in its "keys" stage, an agent edit may change only the
-- key frames of its tag; the frames between them stay empty until motion_clip advances (after walk_check says ok).
-- The stage lives on the tag's Motion Clip (sprite property aseprite-agent "motion"), written by the bridge's
-- motion_clip tool; an older sprite's pixel spec ("concept.spec", key "motion") is read when there is no motion
-- store. Every edit request goes through the gate, execute_lua included, so the keys can't be skipped.
--
--   local Gate = dofile("motion_gate.lua")
--   local gate = Gate.read(sprite)            -- nil, or { clips = { { tag, keys, from, to } }, allowed = { [frame] = bool } }
--   local problem = Gate.check(sprite, gate, before)   -- with before = Gate.snapshot(sprite, gate)

local M = {}

local function isObj(v) return type(v) == "table" or type(v) == "userdata" end

local function decode(sprite, key)
  local text = sprite.properties("aseprite-agent")[key]
  if type(text) ~= "string" or text == "" then return nil end
  -- json.decode gives userdata objects (indexable, ipairs for arrays), not tables.
  local ok, v = pcall(json.decode, text)
  if ok and isObj(v) then return v end
  return nil
end

local function tagNamed(sprite, name)
  for _, t in ipairs(sprite.tags) do
    if tostring(t.name):lower() == tostring(name):lower() then return t end
  end
end

-- The clips in their "keys" stage: { tag, keys (sprite frames), from, to }. From the Motion Clip store (#109: the
-- sprite property aseprite-agent "motion", clips keyed by tag, keys tag-relative), else from an older sprite's pixel
-- spec ("concept.spec", key "motion", keys as sprite frames).
local function keyClips(sprite)
  local out = {}
  local store = decode(sprite, "motion")
  if store then
    if isObj(store.clips) then
      local names = {}
      for _, t in ipairs(sprite.tags) do names[#names + 1] = t.name end
      for _, name in ipairs(names) do
        local c = store.clips[name]
        if isObj(c) and c.stage == "keys" then
          local tag = tagNamed(sprite, name)
          local from, to = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
          local keys = {}
          for _, k in ipairs(c.keys or {}) do
            local at = isObj(k) and math.floor(tonumber(k.at) or 0) or 0
            if at >= 1 and from + at - 1 <= to then keys[#keys + 1] = from + at - 1 end
          end
          out[#out + 1] = { tag = tag.name, keys = keys, from = from, to = to }
        end
      end
    end
    return out
  end
  local spec = decode(sprite, "concept.spec")
  local m = spec and spec.motion
  if not isObj(m) or m.stage ~= "keys" then return out end
  local tag = tagNamed(sprite, m.tag)
  if not tag then return out end
  local keys = {}
  for _, k in ipairs(m.keys or {}) do
    local f = math.floor(tonumber(k) or 0)
    if f >= 1 and f <= #sprite.frames then keys[#keys + 1] = f end
  end
  out[1] = { tag = tag.name, keys = keys, from = tag.fromFrame.frameNumber, to = tag.toFrame.frameNumber }
  return out
end

-- The sprite's gate when a clip is in its "keys" stage: the clips, and the frames an edit may change (every frame
-- except a staged tag's non-key frames). nil when no clip is in the keys stage.
function M.read(sprite)
  if not sprite then return nil end
  local clips = keyClips(sprite)
  if #clips == 0 then return nil end
  local allowed = {}
  for f = 1, #sprite.frames do allowed[f] = true end
  for _, c in ipairs(clips) do
    local isKey = {}
    for _, k in ipairs(c.keys) do isKey[k] = true end
    for f = c.from, math.min(c.to, #sprite.frames) do
      if not isKey[f] then allowed[f] = false end
    end
  end
  return { clips = clips, allowed = allowed }
end

-- The frames of the tag that may not change yet.
local function locked(sprite, gate)
  local out = {}
  for f = 1, #sprite.frames do
    if gate.allowed[f] == false then out[#out + 1] = f end
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
  local parts = {}
  for _, c in ipairs(gate.clips) do
    local keys = {}
    for _, k in ipairs(c.keys) do keys[#keys + 1] = tostring(k) end
    local l = {}
    for f = c.from, math.min(c.to, #sprite.frames) do
      if gate.allowed[f] == false then l[#l + 1] = tostring(f) end
    end
    parts[#parts + 1] = "Motion clip \"" .. c.tag .. "\" is in its keys stage: draw only the key frames (" .. table.concat(keys, ", ") ..
      ") until motion_clip advance (walk_check must say ok for a walk); frames " .. table.concat(l, ", ") .. " stay as they are."
  end
  return table.concat(parts, " ")
end

return M
