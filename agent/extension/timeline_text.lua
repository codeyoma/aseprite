-- Timeline as text (#32): a compact, readable form of the sprite's timeline
-- that agents (and people) can read, edit and apply in one step.
--
--   frames 12
--   frame 1-4 duration 100ms
--   frame 5-12 duration 80ms
--   tag idle 1-4 ping-pong
--   tag walk 5-12 forward repeat=2
--   layer "Shadow" link 5-12
--
-- `frames`, `frame ... duration` (or `fps N`) and `tag` lines describe the
-- whole timeline: tags that are not listed are removed, frames not covered
-- by a duration line keep theirs. `layer <name|L12> link A-B` links that
-- layer's cels in frames A-B to the cel in A, and `unlink A-B` gives each
-- its own copy; layers that are not mentioned are left as they are.
-- Comments start with #.
--
--   local T = dofile("timeline_text.lua")
--   T.serialize(sprite)                -> text
--   T.parse(text)                      -> spec, errors   (errors: { "line 3: ..." })
--   T.plan(sprite, spec)               -> changes, errors
--   T.apply(sprite, spec, layerById)   -> changes  (one undo step)

local M = {}

local DIRS = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, ["ping-pong"] = AniDir.PING_PONG,
               ["ping-pong-reverse"] = AniDir.PING_PONG_REVERSE }
local DIR_NAMES = {}
for k, v in pairs(DIRS) do DIR_NAMES[v] = k end

local function ms(seconds) return math.floor(seconds * 1000 + 0.5) end

local function quote(name)
  if name:match("^[%w_%-%.]+$") then return name end
  return '"' .. name:gsub('"', '\\"') .. '"'
end

local function range(a, b) return a == b and tostring(a) or (a .. "-" .. b) end

local function eachLayer(layers, fn)
  for _, l in ipairs(layers) do
    if l.isGroup then eachLayer(l.layers, fn) else fn(l) end
  end
end

---------------------------------------------------------------------------
-- Serialize
---------------------------------------------------------------------------

function M.serialize(sprite)
  local out = { "frames " .. #sprite.frames }
  -- Runs of equal durations.
  local i, n = 1, #sprite.frames
  while i <= n do
    local d = ms(sprite.frames[i].duration)
    local j = i
    while j < n and ms(sprite.frames[j + 1].duration) == d do j = j + 1 end
    out[#out + 1] = string.format("frame %s duration %dms", range(i, j), d)
    i = j + 1
  end
  for _, t in ipairs(sprite.tags) do
    local line = string.format("tag %s %s %s", quote(t.name), range(t.fromFrame.frameNumber, t.toFrame.frameNumber),
      DIR_NAMES[t.aniDir] or "forward")
    if (t.repeats or 0) > 0 then line = line .. " repeat=" .. t.repeats end
    out[#out + 1] = line
  end
  -- Runs of linked cels (consecutive frames sharing one image).
  eachLayer(sprite.layers, function(l)
    local f = 1
    while f <= n do
      local cel = l:cel(f)
      local j = f
      if cel then
        while j < n do
          local nxt = l:cel(j + 1)
          if not (nxt and nxt.image.id == cel.image.id) then break end
          j = j + 1
        end
      end
      if j > f then out[#out + 1] = string.format("layer %s link %s", quote(l.name), range(f, j)) end
      f = j + 1
    end
  end)
  return table.concat(out, "\n") .. "\n"
end

---------------------------------------------------------------------------
-- Parse
---------------------------------------------------------------------------

-- Splits a line into words; "double quoted" words may contain spaces.
local function words(line)
  local out, i = {}, 1
  while i <= #line do
    local c = line:sub(i, i)
    if c:match("%s") then i = i + 1
    elseif c == '"' then
      local j, buf = i + 1, {}
      while j <= #line and line:sub(j, j) ~= '"' do
        if line:sub(j, j) == "\\" then j = j + 1 end
        buf[#buf + 1] = line:sub(j, j)
        j = j + 1
      end
      if j > #line then return nil, "unclosed quote" end
      out[#out + 1] = table.concat(buf)
      i = j + 1
    else
      local j = line:find("%s", i) or (#line + 1)
      out[#out + 1] = line:sub(i, j - 1)
      i = j
    end
  end
  return out
end

local function parseRange(s)
  if not s then return nil end
  local a, b = s:match("^(%d+)%-(%d+)$")
  if a then a, b = tonumber(a), tonumber(b) else a = tonumber(s:match("^(%d+)$")); b = a end
  if not a or a < 1 or b < a then return nil end
  return a, b
end

local function parseDuration(s)
  if not s then return nil end
  local v, unit = s:match("^([%d%.]+)(m?s)$")
  v = tonumber(v)
  if not v or v <= 0 then return nil end
  return unit == "ms" and math.floor(v + 0.5) or ms(v)
end

-- Returns spec, errors. spec = { frames, durations = { {a, b, ms} }, fps, tags = { {name, a, b, dir, repeats} },
-- links = { {layer, a, b, link = true|false} }, hasTags }
function M.parse(text)
  local spec = { durations = {}, tags = {}, links = {} }
  local errors = {}
  local function err(n, msg) errors[#errors + 1] = string.format("line %d: %s", n, msg) end
  local seenTags = {}
  local n = 0
  for raw in (text .. "\n"):gmatch("(.-)\r?\n") do
    n = n + 1
    local line = raw:gsub("#.*$", ""):match("^%s*(.-)%s*$")
    if line ~= "" then
      local w, werr = words(line)
      if not w then err(n, werr)
      elseif w[1] == "frames" then
        local count = tonumber(w[2])
        if not count or count < 1 or count % 1 ~= 0 or #w > 2 then err(n, "expected: frames <count>")
        else spec.frames = count end
      elseif w[1] == "fps" then
        local fps = tonumber(w[2])
        if not fps or fps <= 0 or #w > 2 then err(n, "expected: fps <frames per second>")
        else spec.fps = fps end
      elseif w[1] == "frame" then
        local a, b = parseRange(w[2])
        local d = w[3] == "duration" and parseDuration(w[4])
        if not a or not d or #w > 4 then err(n, "expected: frame <A-B> duration <N>ms")
        else spec.durations[#spec.durations + 1] = { a, b, d, line = n } end
      elseif w[1] == "tag" then
        spec.hasTags = true
        local name = w[2]
        local a, b = parseRange(w[3])
        local dir, repeats, bad = "forward", 0, nil
        for k = 4, #w do
          if DIRS[w[k]] then dir = w[k]
          elseif w[k]:match("^repeat=%d+$") then repeats = tonumber(w[k]:match("%d+"))
          else bad = w[k] end
        end
        if not name or not a then err(n, "expected: tag <name> <A-B> [forward|reverse|ping-pong|ping-pong-reverse] [repeat=N]")
        elseif bad then err(n, "unknown tag option '" .. bad .. "'")
        elseif seenTags[name] then err(n, "tag '" .. name .. "' is listed twice")
        else
          seenTags[name] = true
          spec.tags[#spec.tags + 1] = { name = name, a = a, b = b, dir = dir, repeats = repeats, line = n }
        end
      elseif w[1] == "layer" then
        local a, b = parseRange(w[4])
        if not w[2] or (w[3] ~= "link" and w[3] ~= "unlink") or not a or #w > 4 then
          err(n, "expected: layer <name> link|unlink <A-B>")
        else
          spec.links[#spec.links + 1] = { layer = w[2], a = a, b = b, link = w[3] == "link", line = n }
        end
      else
        err(n, "unknown line '" .. w[1] .. "' (use frames, fps, frame, tag or layer)")
      end
    end
  end
  return spec, errors
end

---------------------------------------------------------------------------
-- Plan and apply
---------------------------------------------------------------------------

-- Desired frame durations (ms) for frames 1..count.
local function targetDurations(sprite, spec, count)
  local d = {}
  for f = 1, count do
    local src = sprite.frames[math.min(f, #sprite.frames)]
    d[f] = ms(src.duration)
  end
  if spec.fps then for f = 1, count do d[f] = ms(1 / spec.fps) end end
  for _, r in ipairs(spec.durations) do
    for f = r[1], math.min(r[2], count) do d[f] = r[3] end
  end
  return d
end

-- The changes `spec` makes to `sprite`, as sentences, and range errors.
function M.plan(sprite, spec, layerById)
  local changes, errors = {}, {}
  local count = spec.frames or #sprite.frames
  local function check(line, a, b, what)
    if b > count then errors[#errors + 1] = string.format("line %d: %s %s is past the last frame (%d)", line, what, range(a, b), count) end
  end
  for _, r in ipairs(spec.durations) do check(r.line, r[1], r[2], "frames") end
  for _, t in ipairs(spec.tags) do check(t.line, t.a, t.b, "tag " .. t.name) end
  for _, l in ipairs(spec.links) do
    check(l.line, l.a, l.b, "frames")
    if not (layerById and layerById(l.layer, sprite)) then
      errors[#errors + 1] = string.format("line %d: no layer '%s'", l.line, l.layer)
    end
  end
  if #errors > 0 then return {}, errors end

  if count ~= #sprite.frames then
    changes[#changes + 1] = string.format("Frame count %d -> %d (%s)", #sprite.frames, count,
      count > #sprite.frames and "new frames copy the last one" or "frames removed from the end")
  end
  local want = targetDurations(sprite, spec, count)
  local f = 1
  while f <= count do
    local have = f <= #sprite.frames and ms(sprite.frames[f].duration) or want[f]
    if f <= #sprite.frames and have ~= want[f] then
      local j = f
      while j < math.min(count, #sprite.frames) and want[j + 1] == want[f]
        and ms(sprite.frames[j + 1].duration) == have do j = j + 1 end
      changes[#changes + 1] = string.format("Frames %s duration %dms -> %dms", range(f, j), have, want[f])
      f = j + 1
    else
      f = f + 1
    end
  end
  if spec.hasTags or #spec.tags > 0 then
    local existing = {}
    for _, t in ipairs(sprite.tags) do existing[t.name] = t end
    local listed = {}
    for _, t in ipairs(spec.tags) do
      listed[t.name] = true
      local e = existing[t.name]
      if not e then
        changes[#changes + 1] = string.format("Add tag %s %s %s", t.name, range(t.a, t.b), t.dir)
      else
        local ea, eb = e.fromFrame.frameNumber, e.toFrame.frameNumber
        if ea ~= t.a or eb ~= t.b then changes[#changes + 1] = string.format("Tag %s %s -> %s", t.name, range(ea, eb), range(t.a, t.b)) end
        if (DIR_NAMES[e.aniDir] or "forward") ~= t.dir then
          changes[#changes + 1] = string.format("Tag %s %s -> %s", t.name, DIR_NAMES[e.aniDir] or "forward", t.dir)
        end
        if (e.repeats or 0) ~= t.repeats then changes[#changes + 1] = string.format("Tag %s repeat %d -> %d", t.name, e.repeats or 0, t.repeats) end
      end
    end
    for _, t in ipairs(sprite.tags) do
      if not listed[t.name] then changes[#changes + 1] = "Remove tag " .. t.name end
    end
  end
  for _, l in ipairs(spec.links) do
    local layer = layerById(l.layer, sprite)
    local already = true
    local first = layer:cel(l.a)
    for fr = l.a + 1, l.b do
      local c = fr <= #sprite.frames and layer:cel(fr) or nil
      local linked = first and c and c.image.id == first.image.id
      if l.link and not linked then already = false end
      if not l.link and linked then already = false end
    end
    if l.link and not first then
      changes[#changes + 1] = string.format("Layer %s has no cel in frame %d to link from; skipped", layer.name, l.a)
    elseif not already then
      changes[#changes + 1] = string.format("%s %s cels %s", l.link and "Link" or "Unlink", layer.name, range(l.a, l.b))
    end
  end
  return changes, {}
end

-- Applies `spec` in one transaction. Returns changes, errors.
function M.apply(sprite, spec, layerById)
  local changes, errors = M.plan(sprite, spec, layerById)
  if #errors > 0 or #changes == 0 then return changes, errors end
  local count = spec.frames or #sprite.frames
  local want = targetDurations(sprite, spec, count)
  app.transaction("Apply timeline text", function()
    while #sprite.frames < count do sprite:newFrame(#sprite.frames) end
    while #sprite.frames > count do sprite:deleteFrame(#sprite.frames) end
    for f = 1, count do
      if ms(sprite.frames[f].duration) ~= want[f] then sprite.frames[f].duration = want[f] / 1000 end
    end
    if spec.hasTags or #spec.tags > 0 then
      local existing, listed = {}, {}
      for _, t in ipairs(spec.tags) do listed[t.name] = true end
      for i = #sprite.tags, 1, -1 do
        local t = sprite.tags[i]
        if listed[t.name] then existing[t.name] = t else sprite:deleteTag(t) end
      end
      for _, t in ipairs(spec.tags) do
        local tag = existing[t.name]
        if not tag then
          tag = sprite:newTag(t.a, t.b)
          tag.name = t.name
        elseif tag.fromFrame.frameNumber ~= t.a or tag.toFrame.frameNumber ~= t.b then
          tag.fromFrame = sprite.frames[t.a]
          tag.toFrame = sprite.frames[t.b]
        end
        if tag.aniDir ~= DIRS[t.dir] then tag.aniDir = DIRS[t.dir] end
        if (tag.repeats or 0) ~= t.repeats then tag.repeats = t.repeats end
      end
    end
    for _, l in ipairs(spec.links) do
      local layer = layerById(l.layer, sprite)
      if not (l.link and not layer:cel(l.a)) then
        local frames = {}
        for fr = l.a, l.b do frames[#frames + 1] = sprite.frames[fr] end
        app.range.layers = { layer }
        app.range.frames = frames
        if l.link then app.command.LinkCels() else app.command.UnlinkCel() end
      end
    end
  end)
  app.range:clear()
  app.refresh()
  return changes, {}
end

return M
