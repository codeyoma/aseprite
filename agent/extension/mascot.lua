-- The mascot: the agent's face (the logo: a white rounded square, two eye
-- bars, a blue-gray chin), drawn in pixels in the chat panel. Each mood is
-- a short looping animation made of a few frames; a frame says how the eyes
-- and chin look, how the face moves and which small icon floats beside it.
--
--   local Mascot = dofile("mascot.lua")
--   local f = Mascot.frame("thinking", seconds)   -- the frame at time t (blinks included)
--   Mascot.draw(gc, x, y, scale, f)              -- draws it, one logo pixel = scale px
--   Mascot.size(scale)                           -- width, height of the drawing
--   Mascot.MOODS, Mascot.GROUPS                  -- every mood, and the moods by group
--
-- Pure apart from draw(gc) (gc: color, fillRect), so tests run in batch mode.

local M = {}

M.WIDTH, M.HEIGHT = 12, 13
-- Room around the face: icons sit up and to the right, the face moves by a
-- pixel or two.
M.LEFT, M.TOP, M.RIGHT = 2, 9, 8

M.COLORS = {
  face = { 255, 255, 255 },
  eye = { 121, 105, 116 },
  chin = { 143, 163, 174 },
  icon = { 200, 200, 208 },   -- icons default to a light gray for the dark panel
  G = { 96, 206, 128 },       -- green: done, found, check
  R = { 238, 104, 104 },      -- red: error, delete, not found
  Y = { 244, 204, 96 },       -- yellow: eureka, celebrate, warning
  B = { 124, 174, 255 },      -- blue: sync, save, sleep
}

-- Eyes: bars at columns 3 and 8, rows 3-6 at rest. Each style lists pixels
-- relative to the eye's column (dx) and row 3 (dy); `side` mirrors it.
local EYES = { 3, 8 }
local function rect(x, y, w, h)
  local out = {}
  for yy = y, y + h - 1 do for xx = x, x + w - 1 do out[#out + 1] = { xx, yy } end end
  return out
end
M.EYE_STYLES = {
  open = rect(0, 0, 1, 4),
  tall = rect(0, -1, 1, 5),
  half = rect(0, 2, 1, 2),
  closed = rect(0, 3, 1, 1),
  dot = rect(0, 2, 1, 1),
  line = rect(-1, 2, 3, 1),
  happy = { { -1, 2 }, { 0, 1 }, { 1, 2 } },          -- ^
  sad = { { -1, 1 }, { 0, 2 }, { 1, 1 } },            -- v
  x = { { -1, 0 }, { 1, 0 }, { 0, 1 }, { -1, 2 }, { 1, 2 } },
  ring = { { -1, 0 }, { 0, 0 }, { 1, 0 }, { -1, 1 }, { 1, 1 }, { -1, 2 }, { 0, 2 }, { 1, 2 } },
  wide = rect(0, -1, 2, 5),
  -- > on the left eye, < on the right (squeezed shut).
  squeeze = { { -1, 0 }, { 0, 1 }, { -1, 2 }, side = true },
  -- Looking down at work: short bars low.
  down = rect(0, 2, 1, 2),
}

-- Chin shapes over rows 9-12 (c = chin, . = face white or clear).
M.CHINS = {
  smile = { "............", "c..........c", "cccccccccccc", ".cccccccccc." },
  flat  = { "............", "............", "cccccccccccc", ".cccccccccc." },
  big   = { "c..........c", "c..........c", "cccccccccccc", ".cccccccccc." },
  frown = { "............", "............", ".cccccccccc.", "cccccccccccc" },
  open  = { "............", "c..........c", "ccccc..ccccc", ".cccccccccc." },
  grit  = { "............", "c..........c", "c.c.c.c.c.cc", ".cccccccccc." },
}

-- Icons ('#' set), drawn up and to the right of the head.
M.ICONS = {
  z = { "####", "..#.", ".#..", "####" },
  q = { ".###.", "#...#", "..##.", ".....", "..#.." },
  bang = { "#", "#", "#", ".", "#" },
  plus = { "..#..", "..#..", "#####", "..#..", "..#.." },
  sparkle = { "#...#", ".#.#.", "..#..", ".#.#.", "#...#" },
  sweat = { ".#", "##", "##" },
  check = { "....#", "...#.", "#.#..", ".#...", "....." },
  cross = { "#...#", ".#.#.", "..#..", ".#.#.", "#...#" },
  gear = { ".#.#.", "#####", "##.##", "#####", ".#.#." },
  lens = { ".##..", "#..#.", "#..#.", ".###.", "...##" },
  pencil = { "...##", "..###", ".###.", "###..", "#...." },
  hammer = { "####.", "####.", "..#..", "..#..", "..#.." },
  wrench = { "#.#..", "###..", ".#...", "..#..", "...##" },
  page = { "####.", "#...#", "#.#.#", "#...#", "#####" },
  bulb = { ".###.", "#...#", "#...#", ".###.", ".###." },
  hourglass = { "#####", ".#.#.", "..#..", ".#.#.", "#####" },
  plug = { ".#.#.", ".#.#.", "#####", ".###.", "..#.." },
  up = { "..#..", ".###.", "#.#.#", "..#..", "..#.." },
  down = { "..#..", "..#..", "#.#.#", ".###.", "..#.." },
  sync = { "###..", "#....", "#...#", "....#", "..###" },
  disk = { "####.", "#.#.#", "#####", "#...#", "#####" },
  note = { "#####", "#...#", "#####", "#...#", "#####" },
  trash = { ".###.", "#####", ".#.#.", ".#.#.", ".###." },
  grid = { "#####", "#.#.#", "#####", "#.#.#", "#####" },
  hand = { "#.#.#", "#.#.#", "#####", "#####", ".###." },
  anger = { "##.##", "#...#", ".....", "#...#", "##.##" },
  heart = { ".#.#.", "#####", "#####", ".###.", "..#.." },
  signal = { "....#", "...##", "..###", ".####", "#####" },
  steam = { "#.#.#", ".#.#.", "#.#.#" },
  waves = { "..#..", ".#..#", ".#..#", ".#..#", "..#.." },
  arrow = { "..#..", "...#.", "#####", "...#.", "..#.." },
  clock = { ".###.", "#.#.#", "#.###", "#...#", ".###." },
  folder = { "##...", "#####", "#...#", "#...#", "#####" },
  -- Tilted, blade down-left, and the blade in a mound: an upright shovel read as a raised finger.
  shovel = { "...##", "...#.", "..#..", ".##..", "##..." },
  shovel_dirt = { "...#.", "..#..", ".##..", "###.#", "#####" },
  web = { ".###.", "#.#.#", "#####", "#.#.#", ".###." },
  star = { "..#..", ".###.", "#####", ".###.", ".#.#." },
  brain = { ".###.", "#.#.#", "#####", "#.#.#", ".###." },
  list = { "#.###", ".....", "#.###", ".....", "#.###" },
  tool = { "#...#", "##.##", ".###.", "..#..", "..#.." },
  key = { ".##..", "#..#.", ".##..", "..#..", "..##." },
}

-- A frame: e (eye style; el/er per eye), ex/ey (eye offset), c (chin),
-- dx/dy (face offset), i (icon), ix/iy (icon offset from its home), ic
-- (icon color key), dots (thinking dots 1-3), bar (progress 0-1 under the
-- face), scan (row of a scan line over the face), d (seconds). Frames take
-- unset fields from the mood's base.
local function mood(base, frames)
  local out = {}
  for _, f in ipairs(frames) do
    local merged = {}
    for k, v in pairs(base) do merged[k] = v end
    for k, v in pairs(f) do merged[k] = v end
    merged.d = merged.d or 0.4
    out[#out + 1] = merged
  end
  return out
end

local MOODS = {}
M.MOODS = MOODS

-- Idle
MOODS.idle = mood({}, { { d = 1.6 }, { dy = -1, d = 0.5 }, { d = 1.2 } })
MOODS.look_around = mood({}, { { ex = -1, d = 0.8 }, { d = 0.3 }, { ex = 1, d = 0.8 }, { ey = -1, d = 0.6 }, { d = 0.6 } })
MOODS.wander = mood({}, { { dx = -1, ex = -1, d = 0.5 }, { dx = 0, d = 0.3 }, { dx = 1, ex = 1, d = 0.5 }, { dx = 0, d = 0.3 } })
MOODS.zone_out = mood({ e = "dot", c = "flat" }, { { d = 2.0 }, { ex = 1, d = 1.0 } })
MOODS.sleepy = mood({ e = "half", c = "flat" }, {
  { i = "z", ic = "B", iy = 0, d = 0.8 }, { e = "closed", i = "z", ic = "B", iy = -1, d = 0.8 },
  { e = "closed", i = "z", ic = "B", iy = -2, dy = 1, d = 0.8 }, { d = 0.6 },
})
MOODS.stretch = mood({ e = "line" }, { { dy = -2, c = "big", d = 0.6 }, { dy = -1, d = 0.3 }, { e = "happy", d = 0.6 }, { e = "open", d = 0.6 } })

-- Receiving
MOODS.listening = mood({ i = "waves" }, { { ey = -1, d = 0.5 }, { ey = -1, ix = 1, d = 0.5 } })
MOODS.reading = mood({ e = "down", i = "page" }, { { ex = -1, d = 0.5 }, { d = 0.4 }, { ex = 1, d = 0.5 }, { ex = -1, ey = 1, d = 0.4 } })
MOODS.acknowledge = mood({}, { { dy = 1, d = 0.25 }, { dy = 0, d = 0.25 }, { dy = 1, e = "happy", d = 0.25 }, { e = "happy", d = 0.6 } })
MOODS.greet = mood({ e = "happy", c = "big" }, { { i = "hand", ix = 0, d = 0.3 }, { i = "hand", ix = 1, d = 0.3 }, { i = "hand", ix = 0, d = 0.3 }, { i = "hand", ix = 1, d = 0.3 } })

-- Thinking
MOODS.thinking = mood({ ex = 1, ey = -1 }, { { dots = 1, d = 0.5 }, { dots = 2, d = 0.5 }, { dots = 3, d = 0.7 }, { dots = 0, d = 0.3 } })
MOODS.deep_thinking = mood({ e = "line", c = "flat" }, { { i = "brain", d = 0.8 }, { i = "brain", iy = -1, d = 0.8 }, { e = "closed", i = "brain", d = 0.8 } })
MOODS.planning = mood({ e = "down", i = "list" }, { { ex = -1, d = 0.5 }, { ex = 0, ey = 1, d = 0.5 }, { ex = 1, d = 0.5 } })
MOODS.computing = mood({ i = "gear" }, { { e = "line", d = 0.2 }, { e = "open", d = 0.2 }, { e = "line", ix = 1, d = 0.2 }, { e = "open", ix = 1, d = 0.2 } })
MOODS.confused = mood({ el = "open", er = "half", i = "q" }, { { dx = -1, d = 0.6 }, { dx = 1, d = 0.6 } })
MOODS.eureka = mood({ e = "wide", c = "big", i = "bulb", ic = "Y" }, { { dy = -1, d = 0.3 }, { d = 0.3 }, { i = "sparkle", d = 0.3 }, { d = 0.5 } })

-- Searching
MOODS.searching = mood({ i = "lens" }, { { ex = -1, ix = -1, d = 0.5 }, { ex = 1, ix = 1, d = 0.5 } })
MOODS.rummaging = mood({ e = "down", i = "folder" }, { { dx = -1, d = 0.25 }, { dx = 1, d = 0.25 }, { dx = 0, iy = -1, d = 0.25 }, { dy = 1, d = 0.25 } })
MOODS.digging = mood({ e = "down", i = "shovel" }, { { dy = 0, iy = -1, ix = 1, d = 0.3 }, { dy = 1, i = "shovel_dirt", iy = 0, d = 0.3 } })
MOODS.scanning = mood({ e = "line" }, { { scan = 2, d = 0.2 }, { scan = 5, d = 0.2 }, { scan = 8, d = 0.2 }, { scan = 5, d = 0.2 } })
MOODS.browsing = mood({ i = "web" }, { { ey = 0, d = 0.4 }, { ey = 1, d = 0.4 }, { ey = 2, ex = 1, d = 0.4 } })
MOODS.found = mood({ e = "wide", c = "big", i = "check", ic = "G" }, { { dy = -1, d = 0.3 }, { d = 0.9 } })
MOODS.not_found = mood({ e = "sad", c = "frown", i = "cross", ic = "R" }, { { d = 0.6 }, { dx = -1, d = 0.3 }, { dx = 1, d = 0.3 }, { d = 0.4 } })

-- Working
MOODS.working_hard = mood({ e = "line", c = "grit", i = "sweat", ix = -14, iy = 3 }, { { dy = 0, d = 0.2 }, { dy = 1, d = 0.2 } })
MOODS.building = mood({ e = "down", i = "hammer" }, { { iy = -1, d = 0.25 }, { iy = 1, dy = 1, d = 0.2 } })
MOODS.writing = mood({ e = "down", i = "pencil" }, { { ix = -1, d = 0.25 }, { ix = 0, iy = 1, d = 0.25 }, { ix = 1, d = 0.25 } })
MOODS.drawing = mood({ e = "down", i = "pencil", ic = "Y" }, { { ix = -1, iy = 1, d = 0.2 }, { ix = 1, iy = 0, d = 0.2 }, { ix = 0, iy = 2, d = 0.2 } })
MOODS.fixing = mood({ e = "squeeze", i = "wrench" }, { { iy = 0, d = 0.25 }, { iy = 1, ix = 1, d = 0.25 } })
MOODS.organizing = mood({ e = "down", i = "grid" }, { { ex = -1, d = 0.3 }, { ex = 1, d = 0.3 }, { ey = 1, d = 0.3 } })
MOODS.deleting = mood({ e = "squeeze", i = "trash", ic = "R" }, { { d = 0.3 }, { iy = 1, d = 0.3 } })
MOODS.tool_pick = mood({ i = "tool" }, { { ex = -1, ix = -1, d = 0.2 }, { ex = 1, ix = 1, d = 0.2 }, { e = "wide", d = 0.3 } })

-- Connecting
MOODS.connecting = mood({ i = "plug" }, { { ix = 1, d = 0.3 }, { ix = 0, d = 0.3 }, { i = "signal", d = 0.4 } })
MOODS.syncing = mood({ i = "sync", ic = "B" }, { { d = 0.3 }, { ix = 1, d = 0.3 }, { iy = 1, ix = 1, d = 0.3 }, { iy = 1, d = 0.3 } })
MOODS.downloading = mood({ e = "down", i = "down", ic = "B" }, { { iy = -2, d = 0.25 }, { iy = 0, d = 0.25 }, { iy = 2, d = 0.25 } })
MOODS.uploading = mood({ ey = -1, i = "up", ic = "B" }, { { iy = 2, d = 0.25 }, { iy = 0, d = 0.25 }, { iy = -2, d = 0.25 } })

-- Saving
MOODS.saving = mood({ e = "down", i = "disk", ic = "B" }, { { iy = -1, d = 0.3 }, { iy = 1, d = 0.3 }, { e = "happy", d = 0.5 } })
MOODS.noting = mood({ e = "down", i = "note" }, { { ex = -1, d = 0.3 }, { ex = 1, d = 0.3 } })
MOODS.remembered = mood({ e = "happy", i = "star", ic = "Y" }, { { dy = -1, d = 0.3 }, { d = 0.8 } })

-- Waiting
MOODS.waiting = mood({ c = "flat" }, { { i = "clock", d = 0.8 }, { i = "clock", ex = 1, d = 0.8 }, { e = "closed", d = 0.15 } })
MOODS.impatient = mood({ e = "line", c = "flat", i = "anger", ic = "R" }, { { dx = -1, d = 0.15 }, { dx = 1, d = 0.15 }, { dx = 0, d = 0.5 } })
MOODS.loading = mood({ i = "hourglass" }, { { bar = 0.25, d = 0.3 }, { bar = 0.5, d = 0.3 }, { bar = 0.75, d = 0.3 }, { bar = 1, d = 0.3 } })

-- Verifying
MOODS.checking = mood({ e = "down", i = "check", ic = "G" }, { { ex = -1, d = 0.4 }, { ex = 1, d = 0.4 }, { ey = 1, d = 0.4 } })
MOODS.testing = mood({ i = "gear" }, { { e = "squeeze", d = 0.3 }, { e = "wide", i = "check", ic = "G", d = 0.5 } })
MOODS.reviewing = mood({ i = "lens" }, { { e = "line", ex = -1, d = 0.5 }, { e = "line", ex = 1, d = 0.5 }, { e = "open", d = 0.4 } })

-- Result and emotion
MOODS.done = mood({ e = "happy", c = "big", i = "check", ic = "G" }, { { dy = -1, d = 0.3 }, { d = 1.2 } })
MOODS.proud = mood({ e = "happy", c = "big", i = "star", ic = "Y" }, { { dy = -1, d = 0.6 }, { dy = -1, i = "sparkle", d = 0.6 } })
MOODS.celebrate = mood({ e = "happy", c = "open", ic = "Y" }, {
  { dy = -2, i = "sparkle", d = 0.2 }, { dy = 0, i = "star", d = 0.2 }, { dy = -2, i = "heart", ic = "R", d = 0.2 }, { dy = 0, d = 0.2 },
})
MOODS.retry = mood({ e = "squeeze", i = "sync" }, { { dx = -1, d = 0.3 }, { dx = 0, e = "open", d = 0.4 } })
MOODS.stuck = mood({ e = "sad", c = "flat", i = "q" }, { { d = 0.8 }, { dx = -1, d = 0.2 }, { dx = 1, d = 0.2 }, { dx = 0, d = 0.6 } })
MOODS.error = mood({ e = "x", c = "frown", i = "bang", ic = "R" }, { { dx = -1, d = 0.1 }, { dx = 1, d = 0.1 }, { dx = 0, d = 1.0 } })
MOODS.flustered = mood({ e = "ring", c = "grit", i = "sweat", ix = -14, iy = 3 }, { { dx = -1, d = 0.15 }, { dx = 1, d = 0.15 } })
MOODS.overloaded = mood({ e = "ring", c = "open", i = "steam", ic = "R" }, { { dy = 0, iy = 0, d = 0.3 }, { dy = 1, iy = -1, d = 0.3 } })
MOODS.apologetic = mood({ e = "sad", c = "frown", i = "sweat", ix = -14, iy = 3 }, { { dy = 1, d = 0.8 }, { dy = 2, d = 0.8 } })

-- Requesting
MOODS.asking = mood({ ey = -1, i = "q", ic = "Y" }, { { dy = 0, d = 0.6 }, { dy = -1, d = 0.4 } })
MOODS.need_approval = mood({ e = "wide", i = "key", ic = "Y" }, { { d = 0.7 }, { e = "open", ix = 1, d = 0.5 } })
MOODS.handoff = mood({ ex = 1, i = "arrow" }, { { ix = 0, d = 0.3 }, { ix = 1, d = 0.3 }, { ix = 2, d = 0.3 } })

M.GROUPS = {
  { "Idle", { "idle", "look_around", "wander", "zone_out", "sleepy", "stretch" } },
  { "Receiving", { "listening", "reading", "acknowledge", "greet" } },
  { "Thinking", { "thinking", "deep_thinking", "planning", "computing", "confused", "eureka" } },
  { "Searching", { "searching", "rummaging", "digging", "scanning", "browsing", "found", "not_found" } },
  { "Working", { "working_hard", "building", "writing", "drawing", "fixing", "organizing", "deleting", "tool_pick" } },
  { "Connecting", { "connecting", "syncing", "downloading", "uploading" } },
  { "Saving", { "saving", "noting", "remembered" } },
  { "Waiting", { "waiting", "impatient", "loading" } },
  { "Verifying", { "checking", "testing", "reviewing" } },
  { "Result", { "done", "proud", "celebrate", "retry", "stuck", "error", "flustered", "overloaded", "apologetic" } },
  { "Requesting", { "asking", "need_approval", "handoff" } },
}

-- The words beside the mascot for a mood ("deep_thinking" -> "Deep thinking").
M.LABELS = { idle = "Ready", look_around = "Ready", wander = "Ready", zone_out = "Ready", sleepy = "Zzz",
  tool_pick = "Picking a tool", need_approval = "Needs your approval", not_found = "Not found",
  working_hard = "Working hard", handoff = "Handing off", waiting = "Waiting", done = "Done" }
function M.label(name)
  return M.LABELS[name] or (name:sub(1, 1):upper() .. name:sub(2):gsub("_", " "))
end

-- One loop of a mood, in seconds.
function M.length(name)
  local total = 0
  for _, f in ipairs(MOODS[name] or MOODS.idle) do total = total + f.d end
  return total
end

M.BLINK_EVERY, M.BLINK_FOR = 3.1, 0.14

-- The frame of mood `name` at time t; open eyes blink now and then.
function M.frame(name, t)
  local frames = MOODS[name] or MOODS.idle
  t = math.max(0, t or 0)
  local at = t % M.length(name)
  local f = frames[#frames]
  for _, fr in ipairs(frames) do
    if at < fr.d then f = fr; break end
    at = at - fr.d
  end
  local e = f.e or "open"
  if (e == "open" or e == "tall" or e == "down") and not f.el and (t % M.BLINK_EVERY) < M.BLINK_FOR then
    local copy = {}
    for k, v in pairs(f) do copy[k] = v end
    copy.e, copy.blink = "closed", true
    return copy
  end
  return f
end

-- Drawing size in canvas pixels.
function M.size(scale)
  return (M.LEFT + M.WIDTH + M.RIGHT) * scale, (M.TOP + M.HEIGHT + 2) * scale
end

local function rgb(c) return Color(c[1], c[2], c[3]) end

function M.draw(gc, x, y, s, f)
  f = f or M.frame("idle", 0)
  local ox, oy = x + (M.LEFT + (f.dx or 0)) * s, y + (M.TOP + (f.dy or 0)) * s
  local function px(col, row, color)
    gc.color = color
    gc:fillRect(Rectangle(ox + col * s, oy + row * s, s, s))
  end
  -- The face: a white square with its top corners cut, rows 0-8.
  local white = rgb(M.COLORS.face)
  for row = 0, 8 do
    for col = 0, M.WIDTH - 1 do
      if not (row == 0 and (col == 0 or col == M.WIDTH - 1)) then px(col, row, white) end
    end
  end
  -- The chin (rows 9-12): chin color, face white elsewhere inside the face.
  local chin = M.CHINS[f.c or "smile"] or M.CHINS.smile
  local blue = rgb(M.COLORS.chin)
  for r, line in ipairs(chin) do
    local row = 8 + r
    for col = 0, M.WIDTH - 1 do
      local ch = line:sub(col + 1, col + 1)
      if ch == "c" then px(col, row, blue)
      elseif row < M.HEIGHT - 1 then px(col, row, white) end
    end
  end
  -- A scan line sweeping the face.
  if f.scan then
    gc.color = rgb(M.COLORS.B)
    gc:fillRect(Rectangle(ox, oy + f.scan * s, M.WIDTH * s, s))
  end
  -- Eyes.
  local eye = rgb(M.COLORS.eye)
  for i, col in ipairs(EYES) do
    local style = M.EYE_STYLES[(i == 1 and f.el or f.er) or f.e or "open"] or M.EYE_STYLES.open
    for _, p in ipairs(style) do
      local dx = p[1]
      if style.side and i == 2 then dx = -dx end
      px(col + dx + (f.ex or 0), 3 + p[2] + (f.ey or 0), eye)
    end
  end
  -- Thinking dots, up and to the right.
  local light = rgb(M.COLORS.icon)
  for i = 1, f.dots or 0 do
    local d = i == 3 and 2 or 1
    gc.color = light
    gc:fillRect(Rectangle(ox + (M.WIDTH + (i - 1) * 2) * s, oy + (1 - i * 2) * s, d * s, d * s))
  end
  -- A progress bar under the face.
  if f.bar then
    gc.color = light
    gc:fillRect(Rectangle(ox, oy + (M.HEIGHT + 1) * s, math.max(1, math.floor(M.WIDTH * f.bar)) * s, s))
  end
  -- The icon, at home up and to the right of the head.
  local icon = f.i and M.ICONS[f.i]
  if icon then
    gc.color = rgb(M.COLORS[f.ic or "icon"] or M.COLORS.icon)
    local ix, iy = M.WIDTH + 1 + (f.ix or 0), -6 + (f.iy or 0)
    for r, line in ipairs(icon) do
      for c = 1, #line do
        if line:sub(c, c) == "#" then
          gc:fillRect(Rectangle(ox + (ix + c - 1) * s, oy + (iy + r - 1) * s, s, s))
        end
      end
    end
  end
end

return M
