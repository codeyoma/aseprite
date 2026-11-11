-- Declarative apply (#88): every op of one request is one undo step, a
-- failed or dry-run request leaves the undo history alone, indexed sprites
-- take palette indexes, and a sub-agent's scoped request may only touch cels.
-- The op results themselves are contract scenarios (contract/apply.json).
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/apply_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local s = Sprite(8, 4)
s.layers[1].name = "Body"
local undoBefore = s.undoHistory.undoSteps

local r = H.call("apply", { ops = {
  { op = "add_layer", name = "Ink" },
  { op = "rect", layer = "Ink", x = 0, y = 0, w = 2, h = 2, color = "#ff0000" },
  { op = "add_frames", count = 3 },
  { op = "set_tag", name = "walk", from = 1, to = 4 },
  { op = "set_palette", colors = { "#000000", "#ff0000", "#00ff00" } },
} })
check("applied", r.applied and r.ok, json.encode(r.errors))
check("four frames, a tag, two layers", #s.frames == 4 and #s.tags == 1 and #s.layers == 2)
check("one undo step", s.undoHistory.undoSteps == undoBefore + 1, s.undoHistory.undoSteps - undoBefore)
app.undo()
check("undo takes the whole apply back", #s.frames == 1 and #s.tags == 0 and #s.layers == 1 and #s.palettes[1] ~= 3)

local bad = H.call("apply", { ops = { { op = "add_layer", name = "X" }, { op = "delete_tag", name = "nope" } } })
check("a failing request is rolled back", not bad.applied and #s.layers == 1 and #bad.errors == 1, json.encode(bad))
local dry = H.call("apply", { dry_run = true, ops = { { op = "add_frames", count = 2 } } })
check("a dry run changes nothing", dry.ok and not dry.applied and #s.frames == 1 and #dry.changes == 1)
check("neither leaves an undo step", s.undoHistory.undoSteps == undoBefore, s.undoHistory.undoSteps - undoBefore)

-- Indexed: a palette index is a color.
local ix = Sprite(4, 1, ColorMode.INDEXED)
local pal = Palette(3)
pal:setColor(0, Color(0, 0, 0)); pal:setColor(1, Color(255, 0, 0)); pal:setColor(2, Color(0, 0, 255))
ix:setPalette(pal)
r = H.call("apply", { ops = { { op = "line", points = { { 0, 0 }, { 3, 0 } }, color = 2 }, { op = "rect", x = 1, y = 0, w = 1, h = 1, color = "#ff0000" } } })
local cel = ix.layers[1]:cel(1)
local got = {}
for x = 0, 3 do got[#got + 1] = cel.image:getPixel(x - cel.position.x, 0 - cel.position.y) end
check("indexed: palette indexes and palette colors", r.ok and table.concat(got, ",") == "2,1,2,2", table.concat(got, ","))
r = H.call("apply", { ops = { { op = "rect", x = 0, y = 0, w = 1, h = 1, color = "#00ff00" } } })
check("indexed: a color outside the palette is refused", not r.ok and r.errors[1].message:find("not in the palette", 1, true), json.encode(r.errors))

-- A sub-agent's scope: only cel ops.
app.sprite = s
r = H.call("apply", { scope = { frames = { 1 } }, ops = { { op = "add_frames" } } })
check("scoped: frame ops are refused", not r.ok and r.errors[1].message:find("sub-agents can only use", 1, true), json.encode(r.errors))

print(failures == 0 and "ALL PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " failures") end
