-- Operation policy (document_handlers.lua, kinds in protocol.json): every
-- request is a read, a write or a scoped-write; every write needs a sprite
-- (unless it says otherwise), is captured, and is guarded or refused in a
-- sub-agent's scope. Each request runs here with sample params against a
-- fresh sprite, so a request whose kind doesn't match what its handler does
-- fails. Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script-param tmp=<dir> --script agent/tests/policy_test.lua
local extDir = app.params.ext
local tmp = app.params.tmp or app.fs.tempPath
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local DocumentHandlers = dofile(app.fs.joinPath(extDir, "document_handlers.lua"))
local StepCapture = dofile(app.fs.joinPath(extDir, "step_capture.lua"))
local px = dofile(app.fs.joinPath(extDir, "pixels.lua"))
local capture = StepCapture.new{ limit = 50, edits = DocumentHandlers.writes(P) }
local H = DocumentHandlers.new{ chunkDir = extDir, protocol = P, capture = capture,
  writePalette = function(pal, path) pal:saveAs(path) end }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Counts the canvas captures step capture takes (before and after a write).
local composites = 0
local realComposite = StepCapture.composite
StepCapture.composite = function(...) composites = composites + 1; return realComposite(...) end

local RGBA_2x2 = "/wAA//8AAP//AAD//wAA/w=="   -- 2x2 opaque red, base64
assert(px.base64Decode(RGBA_2x2) == string.char(255, 0, 0, 255):rep(4))

-- Sample params for every request: a new request needs one here.
local SAMPLES = {
  ping = {}, get_state = {}, get_context = {}, snapshot = {}, read_pixels = { width = 2, height = 2 }, check = {},
  diff_visual = {}, propose_variations = { task = "nothing" }, compile_lua = { code = "return 1" },
  commands_changed = {}, get_timeline_text = {}, state_block = {}, collect_colors = {}, get_palette = {},
  render_text = { text = "A", font = "system=Arial", size = 8 },
  save_palette = { colors = { "#ff0000" }, path = app.fs.joinPath(tmp, "policy.gpl") },
  execute_lua = { code = [[app.useTool{ tool = "pencil", color = Color(0, 255, 0), points = { Point(5, 5) } }]] },
  run_command = { name = "ReplaceColor", params = { from = { __color = "#ff0000" }, to = { __color = "#0000ff" }, tolerance = 0 } },
  apply_timeline_text = { text = "frames 2\nframe 1 duration 70ms" },
  put_image = { width = 2, height = 2, rgba = RGBA_2x2, x = 4, y = 4 },
  write_pixels = { rows = { "g g", "g ." }, legend = { g = "#00ff00" }, x = 5, y = 5 },
  put_images = { images = { { width = 2, height = 2, rgba = RGBA_2x2, frame = 1, x = 4, y = 4, new_layer = "fx" } } },
  split_layer_by_colors = { groups = { { name = "Red", colors = { "#ff0000" } } } },
  mirror_frames = { frames = 1 },
  draw_swatches = { colors = { "#00ff00" } },
  undo = {}, redo = {},
  set_palette = { colors = { "#000000", "#ffffff" } },
  apply_color_map = { map = { ["#ff0000"] = "#0000ff" } },
  set_slice = { name = "box", x = 0, y = 0, w = 2, h = 2 },
  create_sprite = { width = 2, height = 2, rgba = RGBA_2x2 },
  create_animation = { width = 2, height = 2, frames = { { rgba = RGBA_2x2, duration = 100 } } },
  create_tilemap = { tile = 2, width = 2, height = 2, rgba = RGBA_2x2, columns = 1, count = 1, map = { { 0 } } },
}

-- A fresh 8x8 RGB sprite, two frames, a red block on "Body" in frame 1,
-- active frame 1. undo and redo get an edit (and its undo) to work on.
local function fixture(method)
  for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
  local s = Sprite(8, 8, ColorMode.RGB)
  s.layers[1].name = "Body"
  s:newEmptyFrame()
  local img = Image(8, 8, ColorMode.RGB)
  for y = 0, 2 do for x = 0, 2 do img:drawPixel(x, y, app.pixelColor.rgba(255, 0, 0)) end end
  s:newCel(s.layers[1], 1, img, Point(0, 0))
  app.frame = s.frames[1]
  app.layer = s.layers[1]
  if method == "undo" or method == "redo" then
    app.transaction("setup", function() s.layers[1]:cel(1).image:drawPixel(7, 7, app.pixelColor.rgba(0, 0, 255)) end)
    if method == "redo" then app.undo() end
  end
  return s
end

local function state()
  local s = app.sprite
  return { sprite = s, count = #app.sprites, undo = s and s.undoHistory.current, seq = capture:seq() }
end
local function same(a, b) return a.sprite == b.sprite and a.count == b.count and a.undo == b.undo end

local names = {}
for name in pairs(P.requests) do names[#names + 1] = name end
table.sort(names)

-- Every request has a kind and a sample.
for _, name in ipairs(names) do
  local spec = P.requests[name]
  check("kind: " .. name, DocumentHandlers.KINDS[spec.kind], spec.kind)
  check("sample: " .. name, SAMPLES[name] ~= nil)
end

-- Unscoped: reads leave the document and the step capture alone; writes
-- change the document and are captured.
for _, name in ipairs(names) do
  local spec = P.requests[name]
  fixture(name)
  local before = state()
  composites = 0
  local ok, err = pcall(H.call, name, SAMPLES[name])
  local after = state()
  if DocumentHandlers.isWrite(spec) then
    check("write changes the document: " .. name, ok and not same(before, after), err)
    check("write is captured: " .. name, composites >= 2, composites)
  else
    check("read leaves the document alone: " .. name, same(before, after) and after.seq == before.seq, err)
  end
end

-- Scoped (a sub-agent working on frame 2): reads run, scoped-writes that
-- touch frame 1 or add frames/layers are undone, writes are refused.
local scope = { frames = "2", label = "frame 2" }
for _, name in ipairs(names) do
  local spec = P.requests[name]
  fixture(name)
  local params = {}
  for k, v in pairs(SAMPLES[name]) do params[k] = v end
  params.scope = scope
  local before = state()
  local ok, err = pcall(H.call, name, params)
  local after = state()
  if spec.kind == "read" then
    check("scoped read runs: " .. name, same(before, after) and not tostring(err):match("Sub%-agents") and
      not tostring(err):match("Out of scope"), err)
  elseif spec.kind == "write" then
    check("scoped write is refused: " .. name, not ok and tostring(err):match("Sub%-agents can't use " .. name)
      and same(before, after), err)
  else
    check("scoped-write outside the scope is undone: " .. name, not ok and tostring(err):match("Out of scope")
      and after.sprite == before.sprite and after.undo == before.undo and after.count == before.count, err)
  end
end

-- A scoped-write inside the scope stays.
do
  local s = fixture()
  app.frame = s.frames[2]
  local r = H.call("put_image", { width = 2, height = 2, rgba = RGBA_2x2, frame = 2, layer = "Body", scope = scope })
  check("scoped-write inside the scope stays", r.layer and s.layers[1]:cel(2) ~= nil)
end

-- Requests that need an active sprite say so, before their handler runs.
for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
for _, name in ipairs(names) do
  local spec = P.requests[name]
  if DocumentHandlers.needsSprite(spec) then
    local params = {}
    for k, v in pairs(SAMPLES[name]) do if k ~= "layer" and k ~= "above" then params[k] = v end end
    local ok, err = pcall(H.call, name, params)
    check("needs a sprite: " .. name, not ok and tostring(err):match("No active sprite"), err)
  end
  for j = #app.sprites, 1, -1 do app.sprites[j]:close() end
end
check("execute_lua runs without a sprite", H.call("execute_lua", { code = "return 1" }).ok)
check("create_sprite runs without a sprite", H.call("create_sprite", SAMPLES.create_sprite).width == 2)

-- Two instances don't share state.
do
  local other = DocumentHandlers.new{ chunkDir = extDir, protocol = P }
  check("instances are separate", other.handlers ~= H.handlers and other.call ~= H.call)
end

StepCapture.composite = realComposite
print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
