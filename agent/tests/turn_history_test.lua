-- Turn History (#22 revert/restore, #19 changes since the last reply).
-- Batch mode: aseprite -b --script-param ext=<agent/extension> --script agent/tests/turn_history_test.lua
local extDir = app.params.ext
local TH = dofile(app.fs.joinPath(extDir, "turn_history.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Pixels of the whole sprite (all frames), for exact comparisons.
local function pixels(sprite)
  local out = {}
  for f = 1, #sprite.frames do
    local img = Image(sprite.width, sprite.height)
    img:drawSprite(sprite, f)
    out[#out + 1] = img.bytes
  end
  return table.concat(out) .. "|" .. #sprite.layers .. "|" .. #sprite.frames
end

local s = Sprite(16, 16)
s.layers[1].name = "Body"
local body = s.layers[1]
app.transaction("User base", function()
  local img = Image(16, 16); img:drawPixel(1, 1, Color(255, 0, 0))
  s:newCel(body, 1, img, Point(0, 0))
end)
local before = pixels(s)

-- A reply with three steps.
local turn = TH.begin(s)
app.transaction("Add Shadow layer", function() s:newLayer().name = "Shadow" end)
app.transaction("Draw circle", function()
  local cel = body:cel(1); local img = cel.image:clone()
  img:drawPixel(5 - cel.position.x, 5 - cel.position.y, Color(0, 0, 255)); cel.image = img
end)
app.transaction("Add frame", function() s:newFrame(1) end)
TH.finish(turn, s)
local after = pixels(s)

check("three steps recorded", #turn.steps == 3 and turn.steps[1].label == "Add Shadow layer", #turn.steps)
check("status done", TH.status(turn) == "done")
check("no changes right after the reply", TH.changesSince(turn) == nil)

local ok = TH.revert(turn)
check("revert", ok and pixels(s) == before and TH.status(turn) == "undone")
check("revert again refused", not TH.revert(turn))
ok = TH.restore(turn)
check("restore", ok and pixels(s) == after and TH.status(turn) == "done")

-- #19: the user undoes one agent step.
app.undo()
local changes = TH.changesSince(turn)
check("undo reported with label", changes and changes:match("You undid the agent's steps: 'Add frame'") ~= nil, changes)
check("status partly undone", TH.status(turn) == "partly undone")
app.redo()

-- #19: the user draws and adds a layer.
app.transaction("Pencil", function()
  local cel = body:cel(2); local img = cel.image:clone()
  img:drawPixel(9 - cel.position.x, 9 - cel.position.y, Color(0, 255, 0)); cel.image = img
end)
app.transaction("New Layer", function() s:newLayer().name = "Hat" end)
changes = TH.changesSince(turn)
check("user steps listed", changes and changes:match("You did: Pencil, New Layer") ~= nil, changes)
check("added layer named", changes and changes:match("Layers added: Hat %(L%d+%)") ~= nil, changes)
check("changed cel named with frame", changes and changes:match("Pixels changed on: Body %(L%d+%) frame 2") ~= nil, changes)
check("fenced", changes and changes:match("^<changes%-since%-your%-last%-reply") ~= nil)

-- Revert after later edits needs force.
local refused, why = TH.revert(turn)
check("revert with later edits needs force", not refused and why and why:match("edited after") ~= nil, why)
check("hasLaterEdits", TH.hasLaterEdits(turn))
ok = TH.revert(turn, true)
check("forced revert restores the pre-reply pixels", ok and pixels(s) == before)

-- Undo an agent step, then edit: the step is discarded but still reported.
do
  local s2 = Sprite(8, 8)
  local t = TH.begin(s2)
  app.transaction("Agent paints", function() s2:newLayer().name = "Paint" end)
  TH.finish(t, s2)
  app.undo()
  app.transaction("User layer", function() s2:newLayer().name = "Mine" end)
  local c = TH.changesSince(t)
  check("discarded agent step reported", c and c:match("undid and then replaced the agent's steps: 'Agent paints'") ~= nil, c)
  check("discarded step counts as undone", TH.status(t) == "undone")
  check("discarded step can't be reverted", not TH.canRevert(t))
  s2:close()
  app.sprite = s
end

-- A reply that switched sprites can't be reverted.
local t2 = TH.begin(s)
local other = Sprite(4, 4)
app.transaction("x", function() other:newLayer() end)
TH.finish(t2, other)
check("other sprite: no revert", not TH.canRevert(t2))
other:close()
check("closed sprite: gone", TH.status(t2) == "gone" or TH.status(t2) == "empty")

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
