-- AI layers and variations (#25): aiLayer, variationLayer, propose, pick, discard.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/variations_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local shown
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P,
  onVariations = function(info) shown = info end }
local V = H.variations()

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function names(s)
  local out = {}
  for _, l in ipairs(s.layers) do out[#out + 1] = l.name end
  return table.concat(out, ",")
end
local function lua(code)
  local r = H.call("execute_lua", { code = code })
  assert(r.ok, r.error)
  return r.value
end

local s = Sprite(16, 16, ColorMode.INDEXED)
app.layer = s.layers[1]

-- aiLayer: a new layer above the active one, with the prompt stored.
lua([[local l = aiLayer("Shadow", "add a shadow")
  app.useTool{ tool = "pencil", color = Color{ index = 1 }, points = { Point(1, 1) } }]])
check("aiLayer above source", names(s) == "Layer 1,AI: Shadow", names(s))
check("prompt stored", s.layers[2].properties("aseprite-agent").prompt == "add a shadow")

-- Variations: three candidates, each its own step.
app.layer = s.layers[1]
for i = 1, 3 do
  lua(string.format([[local l = variationLayer("sword", %d)
    local img = Image(16, 16, ColorMode.INDEXED); img:drawPixel(%d, 5, %d)
    app.sprite:newCel(l, 1, img, Point(0, 0))]], i, i, i + 1))
end
local group = V.findGroup("sword")
check("group above source", group and s.layers[2] == group, names(s))
check("three candidates, newest visible", group and #group.layers == 3 and group.layers[3].isVisible
  and not group.layers[1].isVisible)

local r = H.call("propose_variations", { task = "sword" })
check("propose lists them", r.count == 3 and r.layers[2] == "AI: sword v2" and r.shown)
-- Candidates cover x 1..3, y 5: thumbnails crop to that plus a 2px margin (clipped at x=0).
check("thumbnails cropped to the candidates", shown and #shown.items == 3 and shown.items[2].image.width == 6
  and shown.items[2].image.height == 5 and app.pixelColor.rgbaA(shown.items[2].image:getPixel(2, 2)) == 255,
  shown and (shown.items[2].image.width .. "x" .. shown.items[2].image.height))
check("unknown task errors", not pcall(H.call, "propose_variations", { task = "axe" }))

-- Pick v2: one layer "AI: sword" with the prompt, group gone, one undo step.
local before = #s.layers
local kept = V.pick("sword", 2, "3 swords")
check("pick keeps one layer", kept and kept.name == "AI: sword" and not V.findGroup("sword") and #s.layers == before, names(s))
check("picked prompt stored", kept.properties("aseprite-agent").prompt == "3 swords")
check("picked pixels", kept:cel(1) and kept:cel(1).image:getPixel(2 - kept:cel(1).position.x, 5 - kept:cel(1).position.y) == 3)
app.undo()
check("pick is one undo step", V.findGroup("sword") ~= nil and #V.findGroup("sword").layers == 3)

-- Discard: back to the layers before the variations.
check("discard", V.discard("sword") and not V.findGroup("sword") and names(s) == "Layer 1,AI: Shadow", names(s))

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
