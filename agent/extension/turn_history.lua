-- Turn History: records where each agent reply sits in the sprite's undo
-- history, so a reply can be reverted and restored (#22), and so the next
-- message can tell the agent what changed since its last reply (#19).
--
--   local TurnHistory = dofile("turn_history.lua")
--   local turn = TurnHistory.begin(sprite)     -- before the agent runs
--   TurnHistory.finish(turn, app.sprite)       -- after it replies
--   TurnHistory.revert(turn) / TurnHistory.restore(turn)
--   TurnHistory.status(turn)                   -- "done" | "undone" | "partly undone" | "gone"
--   TurnHistory.changesSince(turn)             -- text, or nil when nothing changed
--
-- Built on this fork's sprite.undoHistory (states with ids and labels,
-- the current state) and sprite:undoTo(id).

local M = {}

local function history(sprite)
  local ok, h = pcall(function() return sprite.undoHistory end)
  if ok and h and h.states then return h end
  return nil
end

local function valid(sprite)
  return sprite ~= nil and pcall(function() return sprite.width end)
end

-- Index of each state id in creation order.
local function indexOf(h)
  local idx = {}
  for i, st in ipairs(h.states) do idx[st.id] = i end
  return idx
end

-- A light fingerprint of the document: layers (name, visibility, opacity)
-- and each cel's image identity, version and bounds.
local function fingerprint(sprite)
  local fp = { layers = {}, order = {}, cels = {} }
  local function walk(layers, prefix)
    for _, l in ipairs(layers) do
      local id = "L" .. l.id
      fp.order[#fp.order + 1] = id
      fp.layers[id] = { name = l.name, visible = l.isVisible, opacity = (not l.isGroup) and l.opacity or nil }
      if l.isGroup then
        walk(l.layers, prefix)
      else
        for _, cel in ipairs(l.cels) do
          local b = cel.bounds
          -- id changes when the image is replaced, version when it is edited in place
          fp.cels[id .. ":" .. cel.frameNumber] = string.format("%d.%d@%d,%d,%dx%d", cel.image.id, cel.image.version,
            b.x, b.y, b.width, b.height)
        end
      end
    end
  end
  walk(sprite.layers, "")
  fp.frames = #sprite.frames
  return fp
end

function M.begin(sprite)
  if not valid(sprite) then return { sprite = nil } end
  local h = history(sprite)
  return { sprite = sprite, start = h and h.current or 0 }
end

-- Records the end of a reply. If the agent switched to (or created) another
-- sprite, that sprite's history is recorded and revert is unavailable.
function M.finish(turn, sprite)
  sprite = sprite or turn.sprite
  if not valid(sprite) then return turn end
  local h = history(sprite)
  if not h then return turn end
  if turn.sprite ~= sprite then
    turn.otherSprite = true
    turn.sprite = sprite
    turn.start = nil
  end
  turn.finish = h.current
  turn.fingerprint = fingerprint(sprite)
  -- The reply's steps: states after the start, up to the end state.
  local idx = indexOf(h)
  local from = (turn.start and turn.start ~= 0) and (idx[turn.start] or 0) or 0
  local to = idx[turn.finish] or 0
  turn.steps = {}
  for i = from + 1, to do turn.steps[#turn.steps + 1] = { id = h.states[i].id, label = h.states[i].label } end
  turn.knownStates = {}
  for _, st in ipairs(h.states) do turn.knownStates[st.id] = true end
  return turn
end

-- Is `id` applied at the current position? (A state is applied when it is
-- the current one or comes before it in creation order.)
local function applied(h, idx, id)
  local cur = h.current ~= 0 and idx[h.current] or 0
  local i = idx[id]
  return i ~= nil and i <= cur
end

-- "done", "undone", "partly undone", "empty" (no steps) or "gone" (sprite closed).
function M.status(turn)
  if not turn.steps or #turn.steps == 0 then return "empty" end
  if not valid(turn.sprite) then return "gone" end
  local h = history(turn.sprite)
  if not h then return "gone" end
  local idx = indexOf(h)
  local done = 0
  for _, st in ipairs(turn.steps) do
    -- A step missing from the history was undone and then discarded by a
    -- later edit (linear undo drops redo states), so it counts as undone.
    if idx[st.id] and applied(h, idx, st.id) then done = done + 1 end
  end
  if done == #turn.steps then return "done" end
  if done == 0 then return "undone" end
  return "partly undone"
end

-- True when the user changed the history after this reply (new states, or
-- moved away from the reply's end in a way revert would discard).
function M.hasLaterEdits(turn)
  if not valid(turn.sprite) then return false end
  local h = history(turn.sprite)
  if not h or not turn.knownStates then return false end
  for _, st in ipairs(h.states) do
    if not turn.knownStates[st.id] then return true end
  end
  return false
end

-- Can this reply be reverted, and if not, why?
function M.canRevert(turn)
  if not turn.steps or #turn.steps == 0 then return false, "This reply made no changes" end
  if turn.otherSprite then return false, "This reply worked on another sprite" end
  local s = M.status(turn)
  if s == "gone" then return false, "The sprite is closed" end
  if s == "undone" then return false, "Already reverted" end
  -- Steps discarded from the history can't be reverted exactly.
  local h = history(turn.sprite)
  local idx = h and indexOf(h) or {}
  for _, st in ipairs(turn.steps) do
    if not idx[st.id] then return false, "Some of this reply's steps were undone and replaced" end
  end
  return true
end

-- Undo everything the reply did. With later edits, `force` is required
-- (those edits stay in the history as redo steps until the next edit).
function M.revert(turn, force)
  local ok, why = M.canRevert(turn)
  if not ok then return false, why end
  if M.hasLaterEdits(turn) and not force then return false, "You edited after this reply" end
  local target = turn.start or 0
  return turn.sprite:undoTo(target) and true or false, nil
end

-- Re-apply a reverted reply.
function M.restore(turn)
  if not valid(turn.sprite) or not turn.finish then return false, "Nothing to restore" end
  if M.status(turn) == "done" then return false, "Already applied" end
  return turn.sprite:undoTo(turn.finish) and true or false, nil
end

-- What changed since the reply ended, as short sentences, or nil.
function M.changesSince(turn)
  if not turn or not turn.fingerprint or not valid(turn.sprite) then return nil end
  local sprite = turn.sprite
  local h = history(sprite)
  if not h then return nil end
  local idx = indexOf(h)
  local lines = {}

  -- Agent steps that are no longer applied: undone (still redoable), or
  -- undone and then discarded by a later edit.
  local undone, discarded = {}, {}
  for _, st in ipairs(turn.steps or {}) do
    if not idx[st.id] then discarded[#discarded + 1] = "'" .. st.label .. "'"
    elseif not applied(h, idx, st.id) then undone[#undone + 1] = "'" .. st.label .. "'" end
  end
  if #undone > 0 then lines[#lines + 1] = "You undid the agent's steps: " .. table.concat(undone, ", ") .. "." end
  if #discarded > 0 then
    lines[#lines + 1] = "You undid and then replaced the agent's steps: " .. table.concat(discarded, ", ") .. "."
  end

  -- The user's own steps since then.
  local mine = {}
  for _, st in ipairs(h.states) do
    if not turn.knownStates[st.id] and applied(h, idx, st.id) then mine[#mine + 1] = st.label end
  end
  if #mine > 0 then lines[#lines + 1] = "You did: " .. table.concat(mine, ", ") .. "." end

  -- Document differences.
  local before, now = turn.fingerprint, fingerprint(sprite)
  local added, removed, renamed, hidden, shown = {}, {}, {}, {}, {}
  for _, id in ipairs(now.order) do
    local a, b = before.layers[id], now.layers[id]
    if not a then added[#added + 1] = string.format("%s (%s)", b.name, id)
    else
      if a.name ~= b.name then renamed[#renamed + 1] = string.format("%s -> %s (%s)", a.name, b.name, id) end
      if a.visible and not b.visible then hidden[#hidden + 1] = b.name end
      if not a.visible and b.visible then shown[#shown + 1] = b.name end
    end
  end
  for _, id in ipairs(before.order) do
    if not now.layers[id] then removed[#removed + 1] = string.format("%s (%s)", before.layers[id].name, id) end
  end
  if #added > 0 then lines[#lines + 1] = "Layers added: " .. table.concat(added, ", ") .. "." end
  if #removed > 0 then lines[#lines + 1] = "Layers removed: " .. table.concat(removed, ", ") .. "." end
  if #renamed > 0 then lines[#lines + 1] = "Layers renamed: " .. table.concat(renamed, ", ") .. "." end
  if #hidden > 0 then lines[#lines + 1] = "Layers hidden: " .. table.concat(hidden, ", ") .. "." end
  if #shown > 0 then lines[#lines + 1] = "Layers shown: " .. table.concat(shown, ", ") .. "." end

  -- Changed cels, grouped per layer: "Body (L2) frames 2-3".
  local changed = {}
  local function mark(key)
    local id, f = key:match("^(L%d+):(%d+)$")
    if id and now.layers[id] and before.layers[id] then
      changed[id] = changed[id] or {}
      changed[id][#changed[id] + 1] = tonumber(f)
    end
  end
  for key, v in pairs(now.cels) do if before.cels[key] ~= v then mark(key) end end
  for key in pairs(before.cels) do if not now.cels[key] then mark(key) end end
  local parts = {}
  for _, id in ipairs(now.order) do
    local frames = changed[id]
    if frames then
      table.sort(frames)
      local ranges, i = {}, 1
      while i <= #frames do
        local j = i
        while j < #frames and frames[j + 1] == frames[j] + 1 do j = j + 1 end
        ranges[#ranges + 1] = (i == j) and tostring(frames[i]) or (frames[i] .. "-" .. frames[j])
        i = j + 1
      end
      parts[#parts + 1] = string.format("%s (%s) frame%s %s", now.layers[id].name, id,
        #frames > 1 and "s" or "", table.concat(ranges, ","))
    end
  end
  if #parts > 0 then lines[#lines + 1] = "Pixels changed on: " .. table.concat(parts, "; ") .. "." end
  if now.frames ~= before.frames then
    lines[#lines + 1] = string.format("Frame count changed: %d -> %d.", before.frames, now.frames)
  end

  if #lines == 0 then return nil end
  return '<changes-since-your-last-reply note="what happened in the document after your last reply">\n' ..
    table.concat(lines, "\n") .. "\n</changes-since-your-last-reply>"
end

return M
