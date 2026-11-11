-- The working mascot: the Aseprite logo's face, drawn in pixels while a turn
-- runs. It blinks, looks up and around, squints, bobs and shows thought dots,
-- so a long turn looks like thinking rather than a frozen spinner.
--
--   local Mascot = dofile("mascot.lua")
--   local pose = Mascot.pose(seconds)          -- what the face does at time t
--   Mascot.draw(gc, x, y, scale, pose)         -- draws it (pixel size = scale)
--   Mascot.size(scale)                         -- width, height of the drawing
--
-- Pure apart from draw(gc), so tests check poses in batch mode.

local M = {}

M.WIDTH, M.HEIGHT = 14, 15
-- Room above the face for the bob and the thought dots.
M.TOP = 3

-- The face, from the logo: O outline, o anti-aliased corner, w face, c chin.
M.FACE = {
  ".oOOOOOOOOOOo.",
  "oOwwwwwwwwwwOo",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OwwwwwwwwwwwwO",
  "OcwwwwwwwwwwcO",
  "OccccccccccccO",
  "oOccccccccccOo",
  ".oOOOOOOOOOOo.",
}

M.COLORS = {
  O = { 101, 85, 97 },
  o = { 181, 180, 186 },
  w = { 255, 255, 255 },
  c = { 125, 146, 158 },
}

-- Eyes: two 1-px-wide bars at x 4 and 9, rows 4-7 at rest.
local EYES = { 4, 9 }

-- Poses: dy moves the whole face, ex/ey move the eyes, eh is the eye height
-- (1 = shut), dots the thought dots shown, word what the label says.
local POSES = {
  rest   = { dy = 0, ex = 0, ey = 0, eh = 4, dots = 0, word = "Working" },
  blink  = { dy = 0, ex = 0, ey = 2, eh = 1, dots = 0, word = "Working" },
  up     = { dy = -1, ex = 0, ey = -2, eh = 3, dots = 0, word = "Looking" },
  upright = { dy = -1, ex = 1, ey = -2, eh = 3, dots = 3, word = "Thinking" },
  left   = { dy = 0, ex = -1, ey = 0, eh = 4, dots = 0, word = "Looking" },
  right  = { dy = 0, ex = 1, ey = 0, eh = 4, dots = 0, word = "Looking" },
  squint = { dy = 0, ex = 0, ey = 1, eh = 2, dots = 1, word = "Hmm" },
  bob    = { dy = -1, ex = 0, ey = 0, eh = 4, dots = 0, word = "Working" },
}
M.POSES = POSES

-- One loop of moves (pose, seconds); thought dots grow while "upright" holds.
M.SCRIPT = {
  { "rest", 1.2 }, { "up", 0.9 }, { "upright", 1.6 }, { "rest", 0.6 },
  { "left", 0.5 }, { "right", 0.5 }, { "rest", 0.8 }, { "squint", 1.2 },
  { "rest", 0.4 }, { "bob", 0.2 }, { "rest", 0.2 }, { "bob", 0.2 }, { "rest", 1.0 },
}
M.BLINK_EVERY, M.BLINK_FOR = 2.7, 0.15

local loop = 0
for _, s in ipairs(M.SCRIPT) do loop = loop + s[2] end
M.LOOP = loop

-- The pose at time t (seconds since the turn started).
function M.pose(t)
  t = math.max(0, t or 0)
  local at = t % M.LOOP
  local name, into, length = "rest", 0, 1
  for _, s in ipairs(M.SCRIPT) do
    if at < s[2] then name, into, length = s[1], at, s[2]; break end
    at = at - s[2]
  end
  local p = POSES[name]
  local pose = { name = name, dy = p.dy, ex = p.ex, ey = p.ey, eh = p.eh, dots = p.dots, word = p.word }
  -- Thought dots appear one by one.
  if p.dots == 3 then pose.dots = math.min(3, 1 + math.floor(into / length * 3)) end
  -- Blinks interrupt any pose with open eyes, except the squint.
  if name ~= "squint" and (t % M.BLINK_EVERY) < M.BLINK_FOR then
    pose.name, pose.ey, pose.eh = "blink", p.ey + math.floor(p.eh / 2), 1
  end
  return pose
end

-- Drawing size in canvas pixels, including room for the bob and the dots.
function M.size(scale)
  return (M.WIDTH + 6) * scale, (M.HEIGHT + M.TOP) * scale
end

local function rgb(c) return Color(c[1], c[2], c[3]) end

function M.draw(gc, x, y, s, pose)
  pose = pose or M.pose(0)
  local top = y + (M.TOP + pose.dy) * s
  for row = 1, M.HEIGHT do
    local line = M.FACE[row]
    for col = 1, M.WIDTH do
      local c = M.COLORS[line:sub(col, col)]
      if c then
        gc.color = rgb(c)
        gc:fillRect(Rectangle(x + (col - 1) * s, top + (row - 1) * s, s, s))
      end
    end
  end
  gc.color = rgb(M.COLORS.O)
  for _, ex in ipairs(EYES) do
    gc:fillRect(Rectangle(x + (ex + pose.ex) * s, top + (4 + pose.ey) * s, s, pose.eh * s))
  end
  -- Thought dots up and to the right of the head, growing; light, so they
  -- read on the panel's dark background.
  gc.color = rgb(M.COLORS.o)
  for i = 1, pose.dots do
    local d = i == 3 and 2 or 1
    gc:fillRect(Rectangle(x + (M.WIDTH + (i - 1) * 2) * s, y + (M.TOP + 1 - i) * s + (pose.dy * s), d * s, d * s))
  end
end

return M
