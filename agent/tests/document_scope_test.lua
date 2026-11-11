-- Document-scoped requests (#90): with two sprites open, requests that name
-- the one that is not the active tab (route.doc) write their pixels there,
-- undo only its history, leave the user's tab, frame and layer alone, and
-- capture and guard per sprite. Runs with sprite:transaction (this fork)
-- when the build has it and again without it (the sprite is then made
-- active for each transaction and given back). Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/document_scope_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local DocumentHandlers = dofile(app.fs.joinPath(extDir, "document_handlers.lua"))
local StepCapture = dofile(app.fs.joinPath(extDir, "step_capture.lua"))
local wireParams = dofile(app.fs.joinPath(extDir, "wire_params.lua"))
local capture = StepCapture.new{ limit = 50, edits = DocumentHandlers.writes(P) }
local H = DocumentHandlers.new{ chunkDir = extDir, protocol = P, capture = capture }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

local pc = app.pixelColor
local RED, BLUE = pc.rgba(255, 0, 0, 255), pc.rgba(0, 0, 255, 255)

-- Sprite A ("art": layers Body and Arm, 3 frames), left at frame 2 on Arm,
-- then sprite B ("mine", the user's) active at frame 1 with a red pixel.
local function setup()
  for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
  local a = Sprite(8, 8, ColorMode.RGB)
  a.filename = "art"
  a.layers[1].name = "Body"
  local arm = a:newLayer()
  arm.name = "Arm"
  a:newEmptyFrame(); a:newEmptyFrame()
  app.frame = a.frames[2]
  app.layer = arm
  H.noteSite()   -- the panel does this on every tab switch (sitechange)
  local b = Sprite(4, 4, ColorMode.RGB)
  b.filename = "mine"
  app.transaction("user edit", function() b:newCel(b.layers[1], 1, Image(4, 4, ColorMode.RGB), Point(0, 0)) end)
  app.transaction("user pixel", function()
    local img = b.layers[1]:cel(1).image:clone(); img:drawPixel(0, 0, RED); b.layers[1]:cel(1).image = img
  end)
  app.frame = b.frames[1]
  return a, b
end

local function pixel(sprite, layerName, frame, x, y)
  for _, l in ipairs(sprite.layers) do
    if l.name == layerName then
      local cel = l:cel(frame)
      if not cel then return nil end
      return cel.image:getPixel(x - cel.position.x, y - cel.position.y)
    end
  end
end

local function run(mode)
  local function name(s) return mode .. ": " .. s end
  local a, b = setup()
  local doc = "S" .. a.id
  local bUndo, bLayer = b.undoHistory.current, app.layer
  local aSteps = #a.undoHistory.states
  local activations = H.stats().activations
  local native = H.hasSpriteTransactions()

  -- A write with no frame or layer goes where A was left (frame 2, Arm).
  local r = H.call("write_pixels", { rows = { "r" }, legend = { r = "#0000ff" }, x = 1, y = 1 }, nil, { doc = doc })
  check(name("write goes to the routed sprite"), r.changed == 1 and pixel(a, "Arm", 2, 1, 1) == BLUE, r.layer)
  check(name("default frame and layer are where the sprite was left"), r.frame == 2 and r.layer == "L" .. a.layers[2].id)
  check(name("other sprite's pixels untouched"), pixel(b, "Layer 1", 1, 1, 1) == 0 and pixel(b, "Layer 1", 1, 0, 0) == RED)
  check(name("active tab, frame and layer unchanged"), app.sprite == b and app.frame.frameNumber == 1 and app.layer == bLayer)
  check(name("one undo step on the routed sprite"), #a.undoHistory.states == aSteps + 1, #a.undoHistory.states - aSteps)
  check(name("user's history unchanged"), b.undoHistory.current == bUndo)
  if native then
    check(name("no activation with sprite:transaction"), H.stats().activations == activations, H.stats().activations - activations)
  else
    check(name("without sprite:transaction the sprite is activated and given back"), H.stats().activations > activations)
  end

  -- Explicit layer and frame refs resolve against the routed sprite (a name B lacks).
  r = H.call("put_image", { width = 1, height = 1, rgba = "/wAA/w==", frame = 3, layer = "Body", x = 2, y = 2 }, nil, { doc = doc })
  check(name("layer names resolve in the routed sprite"), pixel(a, "Body", 3, 2, 2) == RED, r.layer)
  check(name("a layer B lacks is no error"), r.name == "Body")
  local okBad, errBad = pcall(H.call, "write_pixels", { rows = { "r" }, legend = { r = "#ff0000" }, frame = 4 }, nil, { doc = doc })
  check(name("frames are checked against the routed sprite"), not okBad and tostring(errBad):match("out of range"), errBad)

  -- Undo moves only the routed sprite's history.
  H.call("undo", { steps = 2 }, nil, { doc = doc })
  check(name("undo reverts the routed sprite"), pixel(a, "Arm", 2, 1, 1) ~= BLUE and pixel(a, "Body", 3, 2, 2) ~= RED)
  check(name("undo leaves the user's sprite alone"), pixel(b, "Layer 1", 1, 0, 0) == RED and b.undoHistory.current == bUndo)
  H.call("redo", { steps = 1 }, nil, { doc = doc })
  check(name("redo replays on the routed sprite"), pixel(a, "Arm", 2, 1, 1) == BLUE and pixel(a, "Body", 3, 2, 2) ~= RED)
  H.call("redo", {}, nil, { doc = doc })
  check(name("app.sprite unchanged after undo/redo"), app.sprite == b and app.frame.frameNumber == 1)

  -- An apply rolled back (dry run) leaves the routed sprite as it was.
  local before = a.undoHistory.current
  r = H.call("apply", { ops = { { op = "rect", layer = "Arm", frame = 1, x = 0, y = 0, w = 2, h = 2, color = "#00ff00" } }, dry_run = true },
    nil, { doc = doc })
  check(name("dry run rolls back on the routed sprite"), r.ok and not r.applied and a.undoHistory.current == before and pixel(a, "Arm", 1, 0, 0) == nil)
  r = H.call("apply", { ops = { { op = "add_layer", name = "Shade" }, { op = "rect", layer = "Shade", frame = 1, x = 0, y = 0, w = 2, h = 2, color = "#00ff00" } } },
    nil, { doc = doc })
  check(name("apply runs on the routed sprite, one step"), r.applied and #a.layers == 3 and #b.layers == 1
    and app.sprite == b, r.errors and r.errors[1] and r.errors[1].message)

  -- get_state and state_block describe the routed sprite; the ids name the sprites.
  local st = H.call("get_state", {}, nil, { doc = doc })
  check(name("get_state describes the routed sprite"), st.activeSprite.filename == "art" and st.activeSprite.id == doc
    and st.activeFrame == 2 and st.activeLayerId == "L" .. a.layers[2].id, st.activeSprite and st.activeSprite.filename)
  check(name("get_state lists each sprite's id"), #st.openSprites == 2 and st.openSprites[1].id ~= st.openSprites[2].id)
  check(name("a routed get_state has the State shape"), pcall(wireParams.checkResult, P, "get_state", st))
  check(name("a routed state has no timeline range or zoom"), st.timelineRange == nil and st.zoom == nil)
  local blockText = H.call("state_block", {}, nil, { doc = doc }).text
  check(name("state_block describes the routed sprite"), blockText:match("sprite: art") ~= nil, blockText)
  check(name("unrouted get_state is the active sprite"), H.call("get_state", {}).activeSprite.filename == "mine")

  -- Step capture: each step is on its own sprite; diff_visual compares the routed sprite.
  capture.chat = "c1"
  H.call("write_pixels", { rows = { "r" }, legend = { r = "#ff0000" }, x = 5, y = 5, layer = "Arm", frame = 2 }, nil, { doc = doc })
  capture.chat = "c2"
  H.call("write_pixels", { rows = { "r" }, legend = { r = "#0000ff" }, x = 3, y = 3 })
  capture.chat = nil
  local steps = capture.steps
  local s1, s2 = steps[#steps - 1], steps[#steps]
  check(name("steps are keyed by their sprite"), s1.spriteId == a.id and s2.spriteId == b.id and s1.chat == "c1" and s2.chat == "c2")
  check(name("a step is captured on the routed frame"), s1.frame == 2 and s1.changed == 1, s1.frame)
  local c1 = capture:claim(0, "c1")
  check(name("a chat claims only its own sprite's steps"), c1 and c1.spriteId == a.id)
  check(name("other chats' steps on another sprite don't count"), not capture:othersSince(s1.seq - 1, "c1", a.id))
  local hdr = H.call("diff_visual", {}, nil, { doc = doc })
  check(name("diff_visual uses the routed sprite"), hdr.width == 8 and hdr.height == 8, hdr.width)

  -- The scope guard runs on the routed sprite: a step outside the scope is undone there.
  local aUndo = a.undoHistory.current
  local okScope, errScope = pcall(H.call, "write_pixels",
    { rows = { "r" }, legend = { r = "#ff0000" }, x = 0, y = 0, layer = "Arm", frame = 1, scope = { frames = "3" } }, nil, { doc = doc })
  check(name("scope guard undoes on the routed sprite"), not okScope and tostring(errScope):match("Out of scope")
    and a.undoHistory.current == aUndo and pixel(a, "Arm", 1, 0, 0) ~= RED, errScope)
  okScope = pcall(H.call, "write_pixels",
    { rows = { "r" }, legend = { r = "#ff0000" }, x = 0, y = 0, layer = "Arm", frame = 3, scope = { frames = "3" } }, nil, { doc = doc })
  check(name("a scoped write inside the scope stays"), okScope and pixel(a, "Arm", 3, 0, 0) == RED)
  check(name("the user's tab stays during scoped writes"), app.sprite == b)

  -- Agent-written Lua runs in the foreground: its sprite is active while it runs, then the user's comes back.
  local acts = H.stats().activations
  r = H.call("execute_lua", { code = "return app.sprite.filename, app.frame.frameNumber" }, nil, { doc = doc })
  check(name("execute_lua runs with its sprite active"), r.ok and r.value[1] == "art" and r.value[2] == 2, r.value and r.value[1])
  check(name("execute_lua gives the tab back"), app.sprite == b and app.frame.frameNumber == 1 and H.stats().activations == acts + 1)
  r = H.call("execute_lua", { code = "app.sprite.layers[1].name = 'Torso'" }, nil, { doc = doc })
  check(name("execute_lua's step is on its sprite"), a.layers[1].name == "Torso" and b.layers[1].name == "Layer 1")
  local route = {}
  r = H.call("execute_lua", { code = "Sprite(2, 2)" }, nil, route)
  check(name("a request that makes a sprite reports it"), route.moved == app.sprite.id and app.sprite ~= b)

  -- A doc that names no open sprite is an error, never the active sprite.
  local okGone, errGone = pcall(H.call, "write_pixels", { rows = { "r" }, legend = { r = "#ff0000" } }, nil, { doc = "S999999" })
  check(name("unknown doc is an error"), not okGone and tostring(errGone):match("Sprite not found"), errGone)
end

-- sprite:transaction itself (this fork, src/app/script/sprite_class.cpp): one
-- step on that sprite while another is active, rollback on error, results
-- returned, and nesting inside app.transaction on the active sprite.
do
  local a, b = setup()
  if H.hasSpriteTransactions() then
    local n = #a.undoHistory.states
    local x, y = a:transaction("two changes", function() a:newLayer(); a:newFrame(); return 1, 2 end)
    check("sprite:transaction is one step on its sprite", #a.undoHistory.states == n + 1
      and a.undoHistory.states[n + 1].label == "two changes" and x == 1 and y == 2)
    check("sprite:transaction leaves the active sprite", app.sprite == b and b.undoHistory.current ~= nil)
    local layers = #a.layers
    local ok = pcall(a.transaction, a, function() a:newLayer(); error("boom") end)
    check("sprite:transaction rolls back on error", not ok and #a.layers == layers and #a.undoHistory.states == n + 1)
    local bSteps = #b.undoHistory.states
    app.transaction("outer on b", function()
      a:transaction("inner on a", function() a:newLayer() end)
      b:newLayer()
    end)
    check("nested in another sprite's transaction, each sprite gets its own step",
      #a.undoHistory.states == n + 2 and #b.undoHistory.states == bSteps + 1)
  else
    print("SKIP sprite:transaction (not in this build)")
  end
end

run("sprite:transaction")
H.setSpriteTransactions(false)
run("activating")
H.setSpriteTransactions(nil)

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
