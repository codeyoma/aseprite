-- The working mascot: poses over time and drawing in batch mode.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/mascot_test.lua
local M = dofile(app.fs.joinPath(app.params.ext, "mascot.lua"))
local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

for i, row in ipairs(M.FACE) do check("row " .. i .. " is 14 wide", #row == M.WIDTH, #row) end
check("15 rows", #M.FACE == M.HEIGHT)
check("starts at rest", M.pose(0.5).name == "rest")
check("blinks", M.pose(M.BLINK_EVERY + 0.05).name == "blink" and M.pose(M.BLINK_EVERY + 0.05).eh == 1)
local seen = {}
for i = 0, math.floor(M.LOOP * 10) do seen[M.pose(i / 10).name] = true end
for _, n in ipairs{ "rest", "blink", "up", "upright", "left", "right", "squint", "bob" } do
  check("pose " .. n .. " happens in a loop", seen[n])
end
local dots = {}
for i = 0, math.floor(M.LOOP * 20) do local p = M.pose(i / 20); if p.name == "upright" then dots[p.dots] = true end end
check("thought dots grow 1 to 3", dots[1] and dots[2] and dots[3])

-- Drawing with a fake graphics context: every rect stays inside size().
local w, h = M.size(2)
local rects, inside = 0, true
local gc = { fillRect = function(_, r)
  rects = rects + 1
  if r.x < 0 or r.y < 0 or r.x + r.width > w or r.y + r.height > h then inside = false end
end }
for i = 0, 100 do M.draw(gc, 0, 0, 2, M.pose(i / 10)) end
check("draws the face and eyes", rects > 150)
check("stays inside its size in every pose", inside)
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
