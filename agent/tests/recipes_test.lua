-- Runs every ```lua block marked "-- recipe: <name>" in agent/guide/recipes.md
-- through the extension's execute_lua, in order, against one sprite.
-- Run: ASEPRITE_AGENT_TEST=1 aseprite -b --script-param ext=<agent/extension> \
--        --script-param guide=<agent/guide> --script-param tmp=<dir> --script agent/tests/recipes_test.lua

local extDir, guideDir, tmp = app.params.ext, app.params.guide, app.params.tmp
dofile(app.fs.joinPath(extDir, "agent.lua"))
init({ path = extDir, preferences = { autoconnect = false }, newMenuGroup = function() end, newCommand = function() end })
local A = __aseprite_agent

local f = io.open(app.fs.joinPath(guideDir, "recipes.md")); local md = f:read("a"); f:close()

local recipes, order = {}, {}
for block in md:gmatch("```lua\n(.-)```") do
  local name = block:match("^%-%- recipe: ([%w%-]+)")
  if name then recipes[name] = block; order[#order + 1] = name end
end

-- Input image for the pixelate recipe: a 128x96 gradient.
local inputPng = app.fs.joinPath(tmp, "recipe_input.png")
do
  local img = Image(128, 96)
  for y = 0, 95 do for x = 0, 127 do img:drawPixel(x, y, Color(x * 2, y * 2, 255 - x)) end end
  img:saveAs(inputPng)
end

local subst = {
  ["/path/to/image.png"] = inputPng,
  ["/path/to/sheet"] = app.fs.joinPath(tmp, "recipe_sheet"),
  ["/path/to/sprite.aseprite"] = app.fs.joinPath(tmp, "recipe_sprite.aseprite"),
}
local noTransaction = { pixelate = true, ["export-sheet"] = true, save = true }

local failures = 0
local function run(name)
  local code = recipes[name]
  for k, v in pairs(subst) do code = code:gsub(k:gsub("%p", "%%%0"), v) end
  local r = A.executeLua{ code = code, transaction = not noTransaction[name] }
  if r.ok then print("PASS " .. name .. " -> " .. (type(r.value) == "table" and json.encode(r.value) or tostring(r.value)))
  else failures = failures + 1; print("FAIL " .. name .. ": " .. tostring(r.error)) end
  return r
end

-- The sequence mirrors a real session.
run("new-sprite")
run("layer-below")
run("draw-circle")
assert(#app.sprite.layers == 4)
run("idle-bob")
check_frames = #app.sprite.frames
run("retime-double")
if #app.sprite.frames ~= check_frames * 2 then failures = failures + 1; print("FAIL retime count " .. #app.sprite.frames) end
run("set-fps")
run("tags")
run("outline")
run("export-sheet")
if not app.fs.isFile(app.fs.joinPath(tmp, "recipe_sheet.png")) then failures = failures + 1; print("FAIL sheet png missing") end
run("save")
run("pixelate")
if app.sprite.width ~= 32 or app.sprite.colorMode ~= ColorMode.INDEXED then failures = failures + 1; print("FAIL pixelate result") end

for _, name in ipairs(order) do
  local tested = ({ ["new-sprite"]=1, ["layer-below"]=1, ["draw-circle"]=1, ["idle-bob"]=1, ["retime-double"]=1,
    ["set-fps"]=1, tags=1, outline=1, ["export-sheet"]=1, save=1, pixelate=1 })[name]
  if not tested then failures = failures + 1; print("FAIL untested recipe: " .. name) end
end

print(failures == 0 and ("ALL " .. #order .. " RECIPES PASSED") or (failures .. " FAILED"))
