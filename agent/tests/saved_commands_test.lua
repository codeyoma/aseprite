-- Saved commands (#26): load, run with args (one undo step), parseArgs, compile_lua.
--   aseprite -b --script-param ext=<agent/extension> --script-param tmp=<dir> --script agent/tests/saved_commands_test.lua
local extDir, tmp = app.params.ext, app.params.tmp
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local function readFile(path)
  local f = io.open(path, "r"); if not f then return nil end
  local t = f:read("a"); f:close(); return t
end
local function writeFile(path, text) local f = assert(io.open(path, "w")); f:write(text); f:close() end
local S = dofile(app.fs.joinPath(extDir, "saved_commands.lua")).new{ dir = tmp, readFile = readFile, executeLua = H.executeLua }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

writeFile(app.fs.joinPath(tmp, "commands.json"), json.encode{ commands = {
  { name = "add-layers", title = "Add Layers", description = "Adds n layers", enabled = true,
    params = { { name = "n", default = 2 } } },
} })
writeFile(app.fs.joinPath(tmp, "add-layers.lua"), [[
for i = 1, args.n do app.sprite:newLayer().name = (args.prefix or "L") .. i end
return #app.sprite.layers
]])

check("load", #S:load() == 1 and S:get("add-layers").title == "Add Layers")
check("reload without a plugin just loads", #S:reload() == 1)

local s = Sprite(8, 8)
local r = S:run("add-layers", {})
check("run with defaults", r.ok and r.value == 3, r.error)
r = S:run("add-layers", S.parseArgs("n=1 prefix=X"))
check("run with args", r.ok and r.value == 4 and s.layers[4].name == "X1", r.error)
app.undo()
check("one undo step per run", #s.layers == 3)
check("unknown command", not S:run("nope", {}).ok)

local a = S.parseArgs("width=2 color=#ff0000 dark big=false")
check("parseArgs", a.width == 2 and a.color == "#ff0000" and a.dark == true and a.big == false)

check("compile_lua ok", H.call("compile_lua", { code = "return 1" }).ok)
local bad = H.call("compile_lua", { code = "end" })
check("compile_lua error", not bad.ok and bad.error:match("expected near") ~= nil, bad.error)

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
