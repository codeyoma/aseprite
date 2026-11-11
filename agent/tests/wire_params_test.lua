-- Batch-mode test of request params at the wire seam (#53): the frame
-- grammar against protocol.json's examples, and H.call checking and
-- resolving params before handlers run.
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/wire_params_test.lua

local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local W = dofile(app.fs.joinPath(extDir, "wire_params.lua"))
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function plainList(v) local o = {} for i = 1, #v do o[i] = math.tointeger(v[i]) or v[i] end return o end

for i, ex in ipairs(P.params.frameSpecExamples) do
  local spec = ex.spec
  if type(spec) == "userdata" or type(spec) == "table" then spec = plainList(spec) end
  local ok, res = pcall(W.resolveFrames, spec, ex.count, ex.active, ex.default)
  if ex.error then
    check("frame example " .. i .. " fails", not ok and tostring(res):find(ex.error, 1, true), res)
  else
    local want = plainList(ex.frames)
    check("frame example " .. i, ok and table.concat(plainList(res), ",") == table.concat(want, ","), ok and table.concat(res, ",") or res)
  end
end

local s = Sprite(8, 8)
s.layers[1].name = "Body"
local g = s:newGroup(); g.name = "Rig"
local arm = s:newLayer(); arm.name = "Arm"; arm.parent = g
s:newFrame(); s:newFrame()
app.frame = s.frames[2]

local function call(method, params) return pcall(H.call, method, params) end
local ok, err = call("snapshot", { layer = "Body", bogus = 1 })
check("unknown params are refused", not ok and tostring(err):find("unknown param 'bogus'", 1, true), err)
ok, err = call("set_slice", { x = 0, y = 0, w = 1, h = 1 })
check("required params are enforced", not ok and tostring(err):find("'name' is required", 1, true), err)
ok, err = call("undo", { steps = "two" })
check("types are checked", not ok and tostring(err):find("'steps' must be a integer", 1, true), err)
ok, err = call("snapshot", { layer = "Nope" })
check("a missing layer is one error", not ok and tostring(err):find("Layer not found: Nope", 1, true), err)
ok, err = call("snapshot", { frame = 9 })
check("frames out of range are refused", not ok and tostring(err):find("out of range", 1, true), err)
local hdr = call("snapshot", { layer = "Arm" }) and select(2, call("snapshot", { layer = "Arm" }))
check("layer names inside groups resolve to ids; frame defaults to the active one",
  hdr and hdr.layer == "L" .. arm.id and hdr.frame == 2, hdr and (tostring(hdr.layer) .. " " .. tostring(hdr.frame)))
ok, err = call("check", { frames = "2-3" })
check("frame specs resolve before the handler", ok, err)
ok, err = call("snapshot", { layer = "Body", scope = { layers = { "Body" } } })
check("scope is always allowed", ok, err)

-- Every request has a params schema with known types.
local known = { string = 1, integer = 1, number = 1, boolean = 1, array = 1, object = 1, any = 1, layer = 1, frame = 1, frames = 1, bytes = 1 }
for name, req in pairs(P.requests) do
  check(name .. " has params", req.params ~= nil)
  for k, t in pairs(req.params or {}) do
    local base = tostring(t):match("^(%a+)")
    check(name .. "." .. k .. " type " .. tostring(t), known[base] ~= nil)
  end
end

print(failures == 0 and "ALL PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " failures") end
