-- AI layers and variations (#25). Generated content goes on its own layer
-- named "AI: <task>" above the source, so the user's pixels stay untouched.
-- For variations, the agent builds candidates as layers in a group
-- "AI variations: <task>"; the chat panel shows them and the user keeps one
-- (pick) or none (discard), each in one undo step.
--
-- Agent Lua (execute_lua) gets aiLayer(task, prompt) and variationLayer(task, i).
-- The prompt is stored in the layer's properties("aseprite-agent").prompt.

local M = {}

M.PREFIX = "AI: "
M.GROUP_PREFIX = "AI variations: "
M.KEY = "aseprite-agent"

local function sprite() return assert(app.sprite, "No active sprite") end

local function each(layers, fn)
  for _, l in ipairs(layers) do
    fn(l)
    if l.isGroup then each(l.layers, fn) end
  end
end

-- Puts `layer` just above `ref`, in ref's parent.
local function placeAbove(layer, ref)
  if not ref then return end
  layer.parent = ref.parent
  layer.stackIndex = ref.stackIndex + 1
end

-- A new layer "AI: <task>" above the active layer (or opts.above), with the
-- prompt stored on it. Returns the layer.
function M.aiLayer(task, prompt, opts)
  local s = sprite()
  local ref = (opts and opts.above) or app.layer
  local layer = s:newLayer()
  layer.name = M.PREFIX .. tostring(task)
  placeAbove(layer, ref)
  local p = layer.properties(M.KEY)
  p.task = tostring(task)
  if prompt then p.prompt = tostring(prompt) end
  app.layer = layer
  return layer
end

function M.findGroup(task, s)
  s = s or app.sprite
  if not s then return nil end
  local name = M.GROUP_PREFIX .. tostring(task)
  local found
  each(s.layers, function(l) if not found and l.isGroup and l.name == name then found = l end end)
  return found
end

-- Variation i of a task: a layer "AI: <task> v<i>" in the task's group
-- (created above the active layer on first use). Only the newest variation
-- is visible, so the canvas shows one candidate at a time.
function M.variationLayer(task, i, opts)
  local s = sprite()
  local group = M.findGroup(task, s)
  if not group then
    local ref = (opts and opts.above) or app.layer
    group = s:newGroup()
    group.name = M.GROUP_PREFIX .. tostring(task)
    placeAbove(group, ref)
    group.properties(M.KEY).task = tostring(task)
  end
  local name = string.format("%s%s v%d", M.PREFIX, tostring(task), i)
  local layer
  for _, l in ipairs(group.layers) do
    if l.name == name then layer = l end
    l.isVisible = false
  end
  if not layer then
    layer = s:newLayer()
    layer.name = name
    layer.parent = group
  end
  layer.isVisible = true
  app.layer = layer
  return layer
end

-- The variation layers of a task, in order v1..vn.
function M.candidates(task, s)
  local group = M.findGroup(task, s)
  if not group then return nil end
  local list = {}
  for _, l in ipairs(group.layers) do
    if not l.isGroup then list[#list + 1] = l end
  end
  table.sort(list, function(a, b)
    return (tonumber(a.name:match("v(%d+)$")) or 0) < (tonumber(b.name:match("v(%d+)$")) or 0)
  end)
  return list, group
end

-- Image of one variation layer on the active frame (the layer alone).
-- toRgb converts cel images of indexed or grayscale sprites.
function M.render(layer, toRgb)
  local s = layer.sprite
  local frame = (app.frame and app.frame.frameNumber) or 1
  local img = Image(s.width, s.height, ColorMode.RGB)
  local cel = layer:cel(frame)
  if cel then img:drawImage(toRgb(cel.image, s.palettes[1], layer.isTilemap and layer.tileset or nil), cel.position) end
  return img
end

-- Keeps variation `index`: it leaves the group as "AI: <task>" with the
-- prompt stored on it, and the group is deleted. One undo step.
function M.pick(task, index, prompt)
  local s = sprite()
  local list, group = M.candidates(task, s)
  if not list then return nil, "No variations for " .. tostring(task) end
  local chosen = list[index]
  if not chosen then return nil, "No variation " .. tostring(index) end
  app.transaction("Keep AI variation", function()
    chosen.parent = group.parent
    chosen.stackIndex = group.stackIndex + 1
    chosen.name = M.PREFIX .. tostring(task)
    chosen.isVisible = true
    local p = chosen.properties(M.KEY)
    p.task = tostring(task)
    if prompt then p.prompt = tostring(prompt) end
    s:deleteLayer(group)
  end)
  app.layer = chosen
  app.refresh()
  return chosen
end

-- Removes every variation of a task. One undo step.
function M.discard(task)
  local s = sprite()
  local group = M.findGroup(task, s)
  if not group then return false, "No variations for " .. tostring(task) end
  app.transaction("Discard AI variations", function() s:deleteLayer(group) end)
  app.refresh()
  return true
end

return M
