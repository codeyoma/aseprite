-- Compiles every Lua module of the extension without running it, so a
-- syntax error fails here instead of at runtime inside Aseprite.
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/syntax_check.lua
local dir, bad = app.params.ext, 0
for _, name in ipairs(app.fs.listFiles(dir)) do
  if name:match("%.lua$") and name ~= "__pref.lua" then
    local ok, err = loadfile(app.fs.joinPath(dir, name))
    if not ok then bad = bad + 1; print("FAIL " .. tostring(err)) end
  end
end
print(bad == 0 and "ALL PASS" or (bad .. " FAILED"))
if bad > 0 then error(bad .. " modules don't compile") end
