-- Step capture and visual diff (#23): edit requests record before/after
-- images and a diff with bounds. Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/step_capture_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local StepCapture = dofile(app.fs.joinPath(extDir, "step_capture.lua"))
local DocumentHandlers = dofile(app.fs.joinPath(extDir, "document_handlers.lua"))
local capture = StepCapture.new{ limit = 3, edits = DocumentHandlers.writes(P) }
local H = DocumentHandlers.new{ chunkDir = extDir, protocol = P, capture = capture }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local sprite = Sprite(16, 16, ColorMode.RGB)
app.command.NewFrame()   -- frame 2 is active after this
app.frame = sprite.frames[1]

H.call("diff_visual", { save = "start" })

-- An edit that draws a 3x2 block at (4,5).
H.call("execute_lua", { code = [[
  app.useTool{ tool = "filled_rectangle", color = Color(255, 0, 0), points = { Point(4, 5), Point(6, 6) } }
]] })
local s1 = capture:last()
check("edit recorded", s1 and s1.method == "execute_lua" and capture:seq() == 1)
check("diff bounds", s1 and s1.bounds and s1.bounds.x == 4 and s1.bounds.y == 5 and s1.bounds.width == 3
  and s1.bounds.height == 2, s1 and s1.bounds)
check("changed count", s1 and s1.changed == 6, s1 and s1.changed)
check("diff pixel red", s1 and app.pixelColor.rgbaR(s1.diff:getPixel(4, 5)) == 255
  and app.pixelColor.rgbaA(s1.diff:getPixel(4, 5)) == 255)
check("before was empty", s1 and s1.before and app.pixelColor.rgbaA(s1.before:getPixel(4, 5)) == 0)

-- Reads and no-op edits record nothing.
H.call("get_state", {})
H.call("execute_lua", { code = "return 1" })
check("reads and no-ops not recorded", capture:seq() == 1)

-- diff_visual against the last step and against the checkpoint.
local header, bytes = H.call("diff_visual", {})
check("diff_visual vs last step", header.changed == 6 and header.bounds.x == 4 and #bytes == 16 * 16 * 4, header.changed)
H.call("execute_lua", { code = [[app.useTool{ tool = "pencil", color = Color(0, 0, 255), points = { Point(0, 0) } }]] })
header = H.call("diff_visual", { checkpoint = "start" })
check("diff_visual vs checkpoint", header.changed == 7 and header.bounds.x == 0 and header.bounds.width == 7, header.changed)
check("unknown checkpoint errors", not pcall(H.call, "diff_visual", { checkpoint = "nope" }))

-- Undo is an edit step too.
H.call("undo", { steps = 1 })
check("undo recorded", capture:last().method == "undo" and capture:last().changed == 1)

-- Claiming hands the unclaimed steps to one chat step (a tool may send
-- several write requests), merged from the first "before" to the last "after".
local a = capture:claim(0)
check("claim merges unclaimed steps", a and a.merged == 3 and a.method == "execute_lua+execute_lua+undo"
  and a.changed == 6 and a.bounds.x == 4, a and a.method)
check("claimed steps are taken", capture:claim(0) == nil)
check("claim since", capture:claim(capture:seq()) == nil)
H.call("execute_lua", { code = [[app.useTool{ tool = "pencil", color = Color(0, 0, 255), points = { Point(1, 1) } }]] })
check("one unclaimed step is claimed as is", capture:claim(0) == capture:last())
-- Steps on different frames: the newest stands for them.
H.call("execute_lua", { code = [[app.useTool{ tool = "pencil", color = Color(0, 0, 255), points = { Point(2, 2) } }]] })
app.frame = sprite.frames[2]
H.call("execute_lua", { code = [[app.useTool{ tool = "pencil", color = Color(0, 0, 255), points = { Point(3, 3) } }]] })
check("steps on other frames: the newest", capture:claim(0) == capture:last() and capture:last().frame == 2)
app.frame = sprite.frames[1]

-- Every write request is captured, and nothing else (the operation policy).
for name, spec in pairs(P.requests) do
  local isWrite = spec.kind == "write" or spec.kind == "scoped-write"
  if (capture.edits[name] == true) ~= isWrite then check("capture list follows the policy: " .. name, false) end
end
check("capture list follows the policy", capture.edits.put_image and capture.edits.undo and not capture.edits.snapshot)
local seqBefore = capture:seq()
H.call("put_image", { width = 1, height = 1, rgba = "/wAA/w==", x = 9, y = 9 })
check("put_image is captured", capture:seq() == seqBefore + 1 and capture:last().method == "put_image")

-- Ring buffer stays bounded.
for i = 1, 5 do H.call("execute_lua", { code = string.format([[app.useTool{ tool = "pencil", color = Color(0, %d, 0), points = { Point(%d, 10) } }]], 50 * i, i) }) end
check("ring buffer bounded", #capture.steps == 3)

-- A new sprite has no comparable "before": only drawn pixels count.
local n0 = capture:seq()
H.call("execute_lua", { code = [[local s = Sprite(8, 8, ColorMode.RGB)
  app.useTool{ tool = "pencil", color = Color(255, 0, 0), points = { Point(2, 3) } }]] })
check("new sprite diff counts drawn pixels", capture:seq() == n0 + 1 and capture:last().changed == 1, capture:last().changed)

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
