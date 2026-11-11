-- Step Capture: before/after images of each edit request, and their visual
-- diff (#23). The extension wraps every request with capture:around(),
-- which records the write requests (the operation policy in
-- document_handlers.lua: kind "write" or "scoped-write" in protocol.json);
-- the chat panel claims a capture for each edit step it shows, and the
-- diff_visual request compares the canvas with the last step or a named
-- checkpoint.
--
--   local StepCapture = dofile("step_capture.lua")
--   local capture = StepCapture.new{ limit = 50, edits = DocumentHandlers.writes(protocol) }
--   capture:around("execute_lua", fn, ...)   -- runs fn, records a step
--   capture:claim(sinceSeq)                  -- the unclaimed steps after sinceSeq, as one
--   StepCapture.diff(before, after)          -- { image, bounds, changed }
--   StepCapture.measure(before, after)       -- { bounds, changed }: no image, fast
--
-- Captures live in memory only: a ring buffer of `limit` steps.

local M = {}
M.__index = M

-- Larger canvases are not captured (the diff walks every pixel).
M.MAX_PIXELS = 512 * 512

local function valid(sprite)
  return sprite ~= nil and pcall(function() return sprite.width end)
end

-- The active frame of the active sprite, flattened, or nil.
function M.composite()
  local sprite = app.sprite
  if not valid(sprite) or sprite.width * sprite.height > M.MAX_PIXELS then return nil end
  local frame = (app.frame and app.frame.frameNumber) or 1
  if frame > #sprite.frames then frame = 1 end
  local img = Image(sprite.width, sprite.height, ColorMode.RGB)
  img:drawSprite(sprite, frame)
  return img, frame
end

-- How many pixels changed between two RGB images, and their bounds (#91).
-- Rows are compared as byte strings first, so only changed rows are walked
-- pixel by pixel. Fully transparent pixels are equal whatever their color.
function M.measure(before, after)
  local w, h = after.width, after.height
  local sameSize = before and before.width == w and before.height == h
  local ab = after.bytes
  local bb = sameSize and before.bytes or string.rep("\0", #ab)
  local minX, minY, maxX, maxY, changed = w, h, -1, -1, 0
  local rowBytes = w * 4
  local unpack = string.unpack
  for y = 0, h - 1 do
    local o = y * rowBytes
    if ab:sub(o + 1, o + rowBytes) ~= bb:sub(o + 1, o + rowBytes) then
      for x = 0, w - 1 do
        local a = unpack("<I4", ab, o + x * 4 + 1)
        local b = unpack("<I4", bb, o + x * 4 + 1)
        if a ~= b and not ((a >> 24) == 0 and (b >> 24) == 0) then
          changed = changed + 1
          if x < minX then minX = x end
          if y < minY then minY = y end
          if x > maxX then maxX = x end
          if y > maxY then maxY = y end
        end
      end
    end
  end
  local bounds = changed > 0 and Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1) or nil
  return { bounds = bounds, changed = changed, sizeChanged = not sameSize }
end

-- A step record whose diff image is made on first use (the panel shows it
-- only when the step is expanded).
local function lazyDiff(step)
  return setmetatable(step, { __index = function(t, k)
    if k ~= "diff" then return nil end
    local img = M.diff(t.before, t.after).image
    rawset(t, "diff", img)
    return img
  end })
end

-- Changed pixels between two RGB images: a diff image (faded "after" with
-- changed pixels in red), the bounds of the change and the count.
function M.diff(before, after)
  local pc = app.pixelColor
  local w, h = after.width, after.height
  local out = Image(w, h, ColorMode.RGB)
  local sameSize = before and before.width == w and before.height == h
  local minX, minY, maxX, maxY, changed = w, h, -1, -1, 0
  local red = pc.rgba(255, 0, 0, 255)
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local a = after:getPixel(x, y)
      -- Without a comparable "before" (new sprite, resized canvas), compare
      -- with an empty canvas. Fully transparent pixels are equal whatever
      -- their color.
      local b = sameSize and before:getPixel(x, y) or 0
      local differs = a ~= b and not (pc.rgbaA(a) == 0 and pc.rgbaA(b) == 0)
      if differs then
        changed = changed + 1
        if x < minX then minX = x end
        if y < minY then minY = y end
        if x > maxX then maxX = x end
        if y > maxY then maxY = y end
        out:drawPixel(x, y, red)
      elseif pc.rgbaA(a) > 0 then
        out:drawPixel(x, y, pc.rgba(pc.rgbaR(a), pc.rgbaG(a), pc.rgbaB(a), pc.rgbaA(a) // 3))
      end
    end
  end
  local bounds = changed > 0 and Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1) or nil
  return { image = out, bounds = bounds, changed = changed, sizeChanged = not sameSize }
end

-- opts.edits: the set of methods to record ({ execute_lua = true, ... }),
-- from the operation policy (DocumentHandlers.writes(protocol)).
function M.new(opts)
  opts = opts or {}
  local edits = assert(opts.edits, "edits required: DocumentHandlers.writes(protocol)")
  return setmetatable({ limit = opts.limit or 50, edits = edits, steps = {}, seqNo = 0, checkpoints = {} }, M)
end

-- Sequence number of the newest step (0 when none yet).
function M:seq() return self.seqNo end

-- Runs fn(...) and, for edit methods, records the active frame before and
-- after. Errors propagate; a failed edit records nothing.
function M:around(method, fn, ...)
  if not self.edits[method] then return fn(...) end
  local okBefore, before = pcall(M.composite)
  local results = table.pack(fn(...))
  local okAfter, after, frame = pcall(M.composite)
  if okAfter and after then
    if not (okBefore and before and before.width == after.width and before.height == after.height
        and before:isEqual(after)) then
      self.seqNo = self.seqNo + 1
      local d = M.measure(okBefore and before or nil, after)
      table.insert(self.steps, lazyDiff{
        seq = self.seqNo, method = method, frame = frame,
        before = okBefore and before or nil, after = after,
        bounds = d.bounds, changed = d.changed,
      })
      if #self.steps > self.limit then table.remove(self.steps, 1) end
    end
  end
  return table.unpack(results, 1, results.n)
end

-- The steps after `sinceSeq` that no chat step has claimed yet, as one: a
-- tool that sends several write requests (a skill tool's put_image, then
-- apply_color_map) is one chat step. Steps on the same frame become one
-- capture from the first one's "before" to the last one's "after";
-- otherwise the newest step stands for them.
function M:claim(sinceSeq)
  local open = {}
  for _, s in ipairs(self.steps) do
    if s.seq > (sinceSeq or 0) and not s.claimed then
      s.claimed = true
      open[#open + 1] = s
    end
  end
  if #open <= 1 then return open[1] end
  local first, last = open[1], open[#open]
  local methods = {}
  for _, s in ipairs(open) do
    if s.frame ~= last.frame then return last end
    methods[#methods + 1] = s.method
  end
  local d = M.measure(first.before, last.after)
  return lazyDiff{
    seq = last.seq, method = table.concat(methods, "+"), frame = last.frame, claimed = true, merged = #open,
    before = first.before, after = last.after, bounds = d.bounds, changed = d.changed,
  }
end

function M:last() return self.steps[#self.steps] end

-- Saves the current canvas as a named checkpoint.
function M:saveCheckpoint(name)
  local img, frame = M.composite()
  if not img then error("No sprite to checkpoint (none open, or larger than 512x512)") end
  self.checkpoints[name] = { image = img, frame = frame }
end

-- diff_visual request: compares the current canvas with the canvas before
-- the last edit step, or with a checkpoint. Returns a header and the diff
-- image's RGBA bytes.
function M:diffVisual(params)
  if params.save then
    self:saveCheckpoint(params.save)
    local s = app.sprite
    return { saved = params.save, width = s.width, height = s.height, changed = 0 }, Image(s.width, s.height, ColorMode.RGB).bytes
  end
  local base, against
  if params.checkpoint then
    local c = self.checkpoints[params.checkpoint]
    if not c then error("No checkpoint named '" .. params.checkpoint .. "'") end
    base, against = c.image, "checkpoint " .. params.checkpoint
  else
    local last = self:last()
    if not last then error("No edit step recorded yet") end
    base, against = last.before, "before the last edit step (" .. last.method .. ")"
  end
  local now = M.composite()
  if not now then error("No sprite open, or larger than 512x512") end
  local d = M.diff(base, now)
  local b = d.bounds
  return {
    width = now.width, height = now.height, against = against, changed = d.changed,
    sizeChanged = d.sizeChanged or nil,
    bounds = b and { x = b.x, y = b.y, width = b.width, height = b.height } or nil,
  }, d.image.bytes
end

return M
