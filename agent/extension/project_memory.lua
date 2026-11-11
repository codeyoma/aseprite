-- Project Memory: the style memory the user approved for a sprite (#93):
-- palette roles, the outline rule, the pixel scale and free notes. The agent
-- proposes an entry with remember_style; the chat shows it as a card and an
-- approved entry is stored in the sprite property aseprite-agent
-- "style.memory" (JSON, saved with the .aseprite file). The State block shows
-- the entries with every message, and the bridge mirrors them into the
-- project folder's AGENTS.md.
--
--   local Memory = dofile("project_memory.lua")
--   Memory.entries(sprite)              -- { { topic, text }, ... }
--   Memory.remember(sprite, topic, text) -- one undo step "Remember style"
--   Memory.forget(sprite, index)
--   Memory.merge(list, entry)           -- pure: the list with the entry added
--   Memory.stateLines(list)             -- pure: lines for the State block

local M = {}

M.KEY = "aseprite-agent"
M.FIELD = "style.memory"
M.TOPICS = { palette = true, outline = true, scale = true, note = true }
-- Topics with one entry: a new one replaces the old.
M.SINGLE = { palette = true, outline = true, scale = true }
M.MAX_NOTES = 20
M.MAX_TEXT = 300
local ORDER = { palette = 1, outline = 2, scale = 3, note = 4 }

local function clean(text)
  text = tostring(text or ""):gsub("%s+", " "):match("^%s*(.-)%s*$")
  if #text > M.MAX_TEXT then text = text:sub(1, M.MAX_TEXT) end
  return text
end

-- The list with `entry` added: a palette, outline or scale entry replaces
-- that topic's entry; a note equal to an existing one is not added twice;
-- the oldest notes go past MAX_NOTES. Sorted by topic, notes in order.
function M.merge(list, entry)
  local topic = M.TOPICS[entry.topic] and entry.topic or "note"
  local text = clean(entry.text)
  local out = {}
  for _, e in ipairs(list or {}) do
    local same = (M.SINGLE[topic] and e.topic == topic) or (e.topic == topic and e.text == text)
    if not same then out[#out + 1] = { topic = e.topic, text = e.text } end
  end
  if text ~= "" then out[#out + 1] = { topic = topic, text = text } end
  local notes = 0
  for i = #out, 1, -1 do
    if out[i].topic == "note" then
      notes = notes + 1
      if notes > M.MAX_NOTES then table.remove(out, i) end
    end
  end
  local indexed = {}
  for i, e in ipairs(out) do indexed[i] = { e = e, i = i } end
  table.sort(indexed, function(a, b)
    local oa, ob = ORDER[a.e.topic] or 9, ORDER[b.e.topic] or 9
    if oa ~= ob then return oa < ob end
    return a.i < b.i
  end)
  for i, x in ipairs(indexed) do out[i] = x.e end
  return out
end

-- Lines for the State block, or nil when there are none.
function M.stateLines(list)
  if not list or #list == 0 then return nil end
  local lines = { "style memory (the user approved these for this project; follow them):" }
  for _, e in ipairs(list) do lines[#lines + 1] = "  " .. e.topic .. ": " .. e.text end
  return lines
end

-- The sprite's entries ({} when none, or the property is not valid JSON).
function M.entries(sprite)
  if not sprite then return {} end
  local ok, raw = pcall(function() return sprite.properties(M.KEY)[M.FIELD] end)
  if not ok or type(raw) ~= "string" or raw == "" then return {} end
  local decoded, data = pcall(json.decode, raw)
  if not decoded or data == nil or type(data) == "string" then return {} end
  -- json.decode's arrays and objects are not always plain tables: read fields only.
  local out = {}
  for _, e in ipairs(data) do
    local ok2, topic, text = pcall(function() return e.topic, e.text end)
    if ok2 and type(text) == "string" then
      out[#out + 1] = { topic = M.TOPICS[topic] and topic or "note", text = text }
    end
  end
  return out
end

-- A transaction belongs to the active sprite, so the chat's sprite is made
-- active for it (and the user's tab comes back).
local function store(sprite, list, label)
  local prev = app.sprite
  if prev ~= sprite then app.sprite = sprite end
  local ok, err = pcall(app.transaction, label, function()
    sprite.properties(M.KEY)[M.FIELD] = #list > 0 and json.encode(list) or nil
  end)
  if prev and prev ~= sprite then pcall(function() app.sprite = prev end) end
  if not ok then error(err, 0) end
end

-- Adds an approved entry in one undo step. Returns the new list.
function M.remember(sprite, topic, text)
  if not sprite then error("No sprite to remember the style for") end
  local list = M.merge(M.entries(sprite), { topic = topic, text = text })
  store(sprite, list, "Remember style")
  return list
end

-- Removes entry `index` in one undo step. Returns the new list, or nil.
function M.forget(sprite, index)
  local list = M.entries(sprite)
  if not list[index] then return nil end
  table.remove(list, index)
  store(sprite, list, "Forget style")
  return list
end

return M
