-- Document View (document_view.lua): the State block, layer ids, the
-- context line and aseprite:// URIs, on their own and as the Document
-- Handlers and the chat panel use them. Batch mode:
--   aseprite -b --script-param ext=<agent/extension> --script agent/tests/document_view_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local px = dofile(app.fs.joinPath(extDir, "pixels.lua"))
local V = dofile(app.fs.joinPath(extDir, "document_view.lua")).new{ px = px }
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Without a sprite.
check("no sprite: state block", V.stateBlock():match("\nno sprite open\n") ~= nil)
check("no sprite: context line", V.contextString() == "no sprite open")
check("no sprite: no targets", #V.Uri.targets() == 0 and V.Uri.resolve("aseprite://frame/1") == nil)

-- State block (#18)
do
  local previous = app.sprite
  local spr = Sprite(32, 16, ColorMode.INDEXED)
  app.sprite = spr
  local body = spr.layers[1]; body.name = "Body"
  local g = spr:newGroup(); g.name = "FX"
  local glow = spr:newLayer(); glow.name = "Glow"; glow.parent = g; glow.opacity = 128
  local hidden = spr:newLayer(); hidden.name = "Sketch"; hidden.isVisible = false
  for _ = 1, 3 do spr:newEmptyFrame() end
  for _, f in ipairs(spr.frames) do f.duration = 0.1 end
  local tag = spr:newTag(1, 3); tag.name = "idle"; tag.aniDir = AniDir.PING_PONG
  spr.selection = Selection(Rectangle(2, 3, 4, 5))
  app.layer = body

  local block = V.stateBlock()
  local lines = {}
  for l in block:gmatch("[^\n]+") do lines[#lines + 1] = l end
  check("state: fenced as data", lines[1]:match("^<aseprite%-state note=") and lines[#lines] == "</aseprite-state>")
  check("state: sprite line", block:match("sprite: Sprite 32x16 indexed, 4 frames, 10 fps") ~= nil, lines[2])
  check("state: palette truncated with count", block:match("palette: 256 colors .- %(%+240%)") ~= nil)
  local order = {}
  for name in block:gmatch("%[L%d+%] (%w+)") do order[#order + 1] = name end
  check("state: layers top to bottom, groups nested", table.concat(order, ",") == "Sketch,FX,Glow,Body", table.concat(order, ","))
  check("state: layer flags", block:match("Sketch %(hidden%)") and block:match("Glow %(50%%%)") and block:match("FX %(group%)") and block:match("Body %(active%)"))
  check("state: indented group child", block:match("\n    %[L%d+%] Glow") ~= nil)
  check("state: tags", block:match("tags: idle 1%-3 ping%-pong") ~= nil)
  check("state: active line", block:match("active: layer L%d+ Body, frame %d+") ~= nil)
  check("state: pixel selection", block:match("pixel selection: x=2 y=3 4x5") ~= nil)
  check("state: deterministic and ids stable", V.stateBlock() == block)

  local id = "L" .. glow.id
  check("layerById by id and name", V.layerById(id) == glow and V.layerById(glow.id) == glow and V.layerById("Body") == body)
  local r = H.executeLua{ code = "return layerById('" .. id .. "').name" }
  check("layerById in agent code", r.ok and r.value == "Glow", r.error)

  -- Budget: 20 layers and 64 colors stay well under ~1.5k tokens (~6000 chars).
  local big = Sprite(64, 64)
  app.sprite = big
  for i = 1, 19 do big:newLayer().name = "Layer number " .. i end
  big.palettes[1]:resize(64)
  local n = #V.stateBlock()
  check("state: size budget", n < 6000, n)
  for i = 1, 45 do big:newLayer() end
  check("state: long layer lists truncated", V.stateBlock():match("%(%+%d+ more layers%)") ~= nil)
  big:close()
  app.sprite = spr
  spr:close()
  if previous then app.sprite = previous end
end

-- aseprite:// URIs (#20): serialize -> resolve round trip, select, stale
do
  local previous = app.sprite
  local U = V.Uri
  local spr = Sprite(16, 16)
  app.sprite = spr
  local body = spr.layers[1]; body.name = "Body"
  local fx = spr:newLayer(); fx.name = "F X"
  spr:newEmptyFrame(); spr:newEmptyFrame()
  local walk = spr:newTag(2, 3); walk.name = "walk left"
  local slice = spr:newSlice(Rectangle(1, 1, 4, 4)); slice.name = "hit box"
  spr.selection = Selection(Rectangle(0, 0, 3, 3))

  local r = U.resolve(U.layer(fx))
  check("uri layer", U.layer(fx) == "aseprite://layer/L" .. fx.id and r and r.layer == fx and r.label == "F X")
  r = U.resolve(U.frame(3)); check("uri frame", r and r.frame == 3)
  r = U.resolve(U.tag(walk)); check("uri tag (encoded)", U.tag(walk) == "aseprite://tag/walk%20left" and r and r.tag == walk)
  r = U.resolve(U.cel(body, 2)); check("uri cel", r and r.layer == body and r.frame == 2)
  r = U.resolve(U.palette(5)); check("uri palette", r and r.index == 5 and r.label:match("^color 5 #"))
  r = U.resolve(U.slice(slice)); check("uri slice", r and r.slice == slice)
  r = U.resolve(U.selection()); check("uri selection", r and r.kind == "selection")

  check("select layer", U.select(U.layer(body)) and app.layer == body)
  check("select frame", U.select(U.frame(2)) and app.frame.frameNumber == 2)
  check("select cel", U.select(U.cel(fx, 3)) and app.layer == fx and app.frame.frameNumber == 3)
  check("select tag", U.select(U.tag(walk)) and app.frame.frameNumber == 2)

  local stale = U.layer(fx)
  spr:deleteLayer(fx)
  check("stale uri resolves to nil", U.resolve(stale) == nil and U.select(stale) == false)
  check("malformed uris", U.resolve("aseprite://layer/xyz") == nil and U.resolve("https://x") == nil
    and U.resolve("aseprite://frame/99") == nil and U.resolve("aseprite://palette/999") == nil)

  local t = U.targets()
  local groups = {}
  for _, x in ipairs(t) do groups[x.group] = true end
  check("picker targets", groups["Layers"] and groups["Tags"] and groups["Frames"] and groups["Palette"] and groups["Slices"]
    and t[1].name == "selection")
  spr:close()
  if previous then app.sprite = previous end
end

-- The Document Handlers answer with the same view.
do
  local spr = Sprite(8, 4)
  spr.layers[1].name = "Body"
  app.layer = spr.layers[1]
  check("handlers share the view", H.stateBlock() == V.stateBlock() and H.contextString() == V.contextString()
    and H.call("state_block", {}).text == V.stateBlock())
  check("get_state from the view", H.call("get_state", {}).activeSprite.layers[1].id == "L" .. spr.layers[1].id)
  check("context line", V.contextString():match("^sprite Sprite 8x4 rgb, 1 frame%(s%); layer Body; frame 1") ~= nil, V.contextString())
  check("layer path and id", V.layerPath(spr.layers[1]) == "Body" and V.layerId(spr.layers[1]) == "L" .. spr.layers[1].id)
  local t = V.Uri.targets()
  check("targets: active layer first, then the layer list", t[1].label == "Active layer: Body" and t[1].uri == V.Uri.layer(spr.layers[1]))
  for _, x in ipairs(t) do
    if not V.Uri.resolve(x.uri) then check("every target resolves: " .. x.uri, false) end
  end
  spr:close()
end

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
