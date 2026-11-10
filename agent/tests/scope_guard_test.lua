-- Scope guard (#33): a scoped sub-agent may only edit its frames/layers.
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/scope_guard_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local Guard = dofile(app.fs.joinPath(extDir, "scope_guard.lua"))

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local s = Sprite(8, 8, ColorMode.RGB)
for i = 1, 3 do s:newFrame() end
local body = s.layers[1]; body.name = "Body"
local shade = s:newLayer(); shade.name = "Shade"
for f = 1, 4 do
  s:newCel(body, f, Image(8, 8, ColorMode.RGB), Point(0, 0))
  s:newCel(shade, f, Image(8, 8, ColorMode.RGB), Point(0, 0))
end
local function draw(layer, frame)
  return string.format([[local c = layerById("%s"):cel(%d); local img = c.image:clone()
    img:drawPixel(1, 1, Color(255, 0, 0)); c.image = img]], layer, frame)
end
local function px(layer, frame) return layer:cel(frame).image:getPixel(1, 1) end

check("parseFrames", Guard.parseFrames("1-2,4", 4)[4] and not Guard.parseFrames("1-2,4", 4)[3]
  and Guard.parseFrames("5", 4) == nil and Guard.parseFrames({ 2, 3 }, 4)[3])

local scope = { frames = "1-2", label = "frames 1-2" }
local r = H.call("execute_lua", { code = draw("Body", 2), scope = scope })
check("edit inside the scope", r.ok and px(body, 2) ~= 0)

local ok, err = pcall(H.call, "execute_lua", { code = draw("Body", 3), scope = scope })
check("edit outside the scope is refused", not ok and tostring(err):match("Out of scope: it changed Body %(L%d+%) in frame 3")
  and tostring(err):match("frames 1,2") ~= nil, err)
check("and undone", px(body, 3) == 0)

ok, err = pcall(H.call, "execute_lua", { code = "app.sprite:newFrame()", scope = scope })
check("frame count change refused", not ok and tostring(err):match("number of frames") and #s.frames == 4, err)

ok, err = pcall(H.call, "execute_lua", { code = "app.sprite:newLayer()", scope = scope })
check("new layers refused", not ok and tostring(err):match("added or removed layers") and #s.layers == 2, err)

ok, err = pcall(H.call, "undo", { scope = scope })
check("undo refused", not ok and tostring(err):match("can't use undo"), err)

local layerScope = { frames = "1-4", layers = { "Shade" } }
r = H.call("execute_lua", { code = draw("Shade", 4), scope = layerScope })
check("layer scope: own layer ok", r.ok and px(shade, 4) ~= 0)
ok, err = pcall(H.call, "execute_lua", { code = draw("Body", 4), scope = layerScope })
check("layer scope: other layer refused", not ok and px(body, 4) == 0, err)

ok, err = pcall(H.call, "execute_lua", { code = "return 1", scope = { frames = "9" } })
check("invalid scope", not ok and tostring(err):match("not valid"), err)

-- Scopes arrive as JSON (userdata) from the bridge.
local fromJson = json.decode(json.encode{ code = draw("Body", 1), scope = { frames = { 1, 2 } } })
r = H.call("execute_lua", fromJson)
check("JSON scope is applied", r.ok and px(body, 1) ~= 0)
ok, err = pcall(H.call, "execute_lua", json.decode('{"code": "return 1", "scope": {"frames": [9]}}'))
check("JSON scope is checked", not ok and tostring(err):match("not valid"), err)

-- Requests without a scope are not guarded.
r = H.call("execute_lua", { code = draw("Body", 3) })
check("unscoped edits unchanged", r.ok and px(body, 3) ~= 0)

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
