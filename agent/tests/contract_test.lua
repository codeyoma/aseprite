-- Replays the document contract scenarios (agent/tests/contract/*.json)
-- against the extension's handlers through H.call, in a headless Aseprite.
-- agent/bridge/test/contract.test.mjs replays the same scenarios against the
-- fake document the bridge tests use. The format is in contract/legend.json.
-- Run: agent/tests/run_lua_tests.sh contract

local extDir = app.params.ext
local contractDir = app.fs.normalizePath(app.fs.joinPath(extDir, "..", "tests", "contract"))

local function readJson(path)
  local f = assert(io.open(path))
  local v = json.decode(f:read("a")); f:close(); return v
end

-- json.decode values to plain Lua tables (arrays by ipairs), whole numbers as integers.
local function plain(v)
  local t = type(v)
  if t == "number" then return math.tointeger(v) or v end
  if t ~= "userdata" and t ~= "table" then return v end
  local copy = {}
  if #v > 0 and v[1] ~= nil then
    for i, x in ipairs(v) do copy[i] = plain(x) end
  else
    for k, x in pairs(v) do copy[k] = plain(x) end
  end
  return copy
end

local P = plain(readJson(app.fs.joinPath(extDir, "protocol.json")))
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local px = dofile(app.fs.joinPath(extDir, "pixels.lua"))
local LEGEND = plain(readJson(app.fs.joinPath(contractDir, "legend.json"))).legend
local pc = app.pixelColor

local failures, passed = 0, 0

local function show(v)
  local ok, s = pcall(json.encode, v)
  return ok and s or tostring(v)
end

---------------------------------------------------------------------------
-- Pixels
---------------------------------------------------------------------------

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(bytes)
  local out = {}
  for i = 1, #bytes, 3 do
    local a, b, c = bytes:byte(i, i + 2)
    local n = (a << 16) | ((b or 0) << 8) | (c or 0)
    local s = {}
    for k = 1, 4 do
      local idx = (n >> (6 * (4 - k))) & 63
      s[k] = B64:sub(idx + 1, idx + 1)
    end
    if not b then s[3], s[4] = "=", "=" elseif not c then s[4] = "=" end
    out[#out + 1] = table.concat(s)
  end
  return table.concat(out)
end

local function legendColor(legend, ch)
  local h = legend[ch]
  if not h then error("no legend entry for '" .. ch .. "'") end
  return px.parseHex(h)
end

-- Rows to RGBA bytes.
local function rowsToBytes(rows, legend)
  local out = {}
  for _, row in ipairs(rows) do
    for x = 1, #row do
      local ch = row:sub(x, x)
      if ch == "." then out[#out + 1] = string.char(0, 0, 0, 0)
      else out[#out + 1] = string.char(legendColor(legend, ch)) end
    end
  end
  return table.concat(out)
end

-- RGBA bytes to rows ('?' for a color the legend lacks), plus the unknown colors.
local function bytesToRows(bytes, w, h, legend)
  local keyOf = {}
  for k, hx in pairs(legend) do keyOf[hx:lower()] = k end
  local rows, unknown = {}, {}
  for y = 0, h - 1 do
    local row = {}
    for x = 0, w - 1 do
      local i = (y * w + x) * 4
      local r, g, b, a = bytes:byte(i + 1, i + 4)
      if a == 0 then row[#row + 1] = "."
      else
        local hx = px.hex(r, g, b, a)
        if not keyOf[hx] then unknown[#unknown + 1] = hx end
        row[#row + 1] = keyOf[hx] or "?"
      end
    end
    rows[#rows + 1] = table.concat(row)
  end
  return rows, unknown
end

---------------------------------------------------------------------------
-- Fixture
---------------------------------------------------------------------------

local MODES = { rgb = ColorMode.RGB, indexed = ColorMode.INDEXED, grayscale = ColorMode.GRAYSCALE }
local DIRS = { forward = AniDir.FORWARD, reverse = AniDir.REVERSE, pingpong = AniDir.PING_PONG, ["ping-pong"] = AniDir.PING_PONG }

local function closeAll()
  while #app.sprites > 0 do app.sprites[1]:close() end
end

local function build(fx, legend)
  closeAll()
  local mode = MODES[fx.colorMode or "rgb"]
  local s = Sprite(fx.width, fx.height, mode)
  if fx.title then s.filename = fx.title end
  local colors = fx.palette or { "#000000", "#ffffff" }
  local pal = Palette(#colors)
  for i, h in ipairs(colors) do pal:setColor(i - 1, Color(px.parseHex(h))) end
  s:setPalette(pal)
  local durations = fx.durations or { 100 }
  for _ = 2, #durations do s:newEmptyFrame() end
  for i, d in ipairs(durations) do s.frames[i].duration = d / 1000 end

  -- A palette index for a color: exact, never the transparent index 0.
  local function indexOf(r, g, b, a)
    if a == 0 then return 0 end
    for i = 1, #pal - 1 do
      local c = pal:getColor(i)
      if c.red == r and c.green == g and c.blue == b and c.alpha == a then return i end
    end
    error(string.format("fixture color %s is not in the palette", px.hex(r, g, b, a)))
  end

  local function image(rows)
    local w, h = #rows[1], #rows
    local img = Image(w, h, mode)
    for y, row in ipairs(rows) do
      for x = 1, #row do
        local ch = row:sub(x, x)
        if ch ~= "." then
          local r, g, b, a = legendColor(legend, ch)
          if mode == ColorMode.RGB then img:drawPixel(x - 1, y - 1, pc.rgba(r, g, b, a))
          elseif mode == ColorMode.INDEXED then img:drawPixel(x - 1, y - 1, indexOf(r, g, b, a))
          else error("grayscale fixtures hold no pixels") end
        end
      end
    end
    return img
  end

  local initial = s.layers[1]
  -- Fixture layers are top first; create them bottom first so each lands on top.
  local function make(list, parent)
    for i = #list, 1, -1 do
      local l = list[i]
      local layer = l.group and s:newGroup() or s:newLayer()
      layer.name = l.name
      layer.parent = parent or s
      if l.group then make(l.layers or {}, layer)
      else
        for k, c in pairs(l.cels or {}) do
          local rows = c[1] ~= nil and c or c.rows
          s:newCel(layer, tonumber(k), image(rows), Point(c.x or 0, c.y or 0))
        end
      end
      if l.visible == false then layer.isVisible = false end
    end
  end
  make(fx.layers or {}, nil)
  s:deleteLayer(initial)

  for _, t in ipairs(fx.tags or {}) do
    local tag = s:newTag(t.from, t.to)
    tag.name = t.name
    if t.direction then tag.aniDir = DIRS[t.direction] end
  end
  -- Fixture slices are in get_state order, which lists the newest first.
  local slices = fx.slices or {}
  for i = #slices, 1, -1 do
    local sl = slices[i]
    local slice = s:newSlice(Rectangle(sl.x, sl.y, sl.w, sl.h))
    slice.name = sl.name
    if sl.center then slice.center = Rectangle(sl.center.x, sl.center.y, sl.center.w, sl.center.h) end
  end
  if fx.selection then
    local r = fx.selection
    s.selection = Selection(Rectangle(r.x, r.y, r.w, r.h))
  end

  local function firstImage(list)
    for _, l in ipairs(list) do
      if not l.group then return l.name end
      local n = firstImage(l.layers or {})
      if n then return n end
    end
  end
  local activeName = fx.activeLayer or firstImage(fx.layers or {})
  if activeName then app.layer = H.layerById(activeName, s) end
  app.frame = s.frames[fx.activeFrame or 1]
  return s
end

---------------------------------------------------------------------------
-- State and matching
---------------------------------------------------------------------------

-- Every layer of a get_state tree, top first.
local function flat(layers, out)
  out = out or {}
  for _, l in ipairs(layers or {}) do
    out[#out + 1] = l
    if l.group then flat(l.layers, out) end
  end
  return out
end

local function normalize(st)
  local s = st.activeSprite
  local function layers(list)
    local out = {}
    for i, l in ipairs(list or {}) do
      local item = { name = l.name, visible = l.visible, group = l.group and true or false }
      if l.group then item.layers = layers(l.layers)
      else item.cels = l.celFrames or {}; item.tilemap = l.tilemap and true or false end
      out[i] = item
    end
    return out
  end
  local durations, tags, activeLayer = {}, {}, nil
  for i, f in ipairs(s.frames) do durations[i] = f.durationMs end
  for i, t in ipairs(s.tags or {}) do tags[i] = { name = t.name, from = t.from, to = t.to, direction = t.direction } end
  for _, l in ipairs(flat(s.layers)) do if l.id == st.activeLayerId then activeLayer = l.name end end
  return {
    title = s.filename, width = s.width, height = s.height, colorMode = s.colorMode,
    durations = durations, activeFrame = st.activeFrame, activeLayer = activeLayer,
    layers = layers(s.layers), tags = tags,
    palette = s.palette and s.palette.colors or {}, slices = s.slices or {}, selection = s.selection,
  }
end

local function isArray(t) return type(t) == "table" and t[1] ~= nil end

-- Partial match (see legend.json); appends mismatches to out.
local function match(want, got, ids, path, out)
  path, out = path or "$", out or {}
  local function fail(msg) out[#out + 1] = path .. ": " .. msg end
  if type(want) == "table" and not isArray(want) and next(want) ~= nil then
    if want["$absent"] then
      if got ~= nil then fail("expected nothing, got " .. show(got)) end
      return out
    end
    if want["$layerId"] then
      local id = ids(want["$layerId"])
      if got ~= id then fail("expected the id of '" .. want["$layerId"] .. "' (" .. tostring(id) .. "), got " .. show(got)) end
      return out
    end
    if want["$set"] then
      local set = want["$set"]
      if type(got) ~= "table" or #got ~= #set then fail("expected " .. #set .. " items in any order, got " .. show(got)); return out end
      local left = {}
      for i, g in ipairs(got) do left[i] = g end
      for _, w in ipairs(set) do
        local found
        for i, g in ipairs(left) do if #match(w, g, ids) == 0 then found = i break end end
        if found then table.remove(left, found) else fail("no item matches " .. show(w) .. " in " .. show(got)) end
      end
      return out
    end
    if type(got) ~= "table" then fail("expected an object, got " .. show(got)); return out end
    for k, v in pairs(want) do match(v, got[k], ids, path .. "." .. tostring(k), out) end
    return out
  end
  if type(want) == "table" then   -- an array (an empty one too)
    if type(got) ~= "table" or #got ~= #want or (#want == 0 and next(got) ~= nil and got[1] ~= nil) then
      fail("expected " .. show(want) .. ", got " .. show(got)); return out
    end
    for i, w in ipairs(want) do match(w, got[i], ids, path .. "[" .. i .. "]", out) end
    return out
  end
  if want ~= got then fail("expected " .. show(want) .. ", got " .. show(got)) end
  return out
end

---------------------------------------------------------------------------
-- Scenarios
---------------------------------------------------------------------------

local function errorText(e)
  if type(e) == "table" then return tostring(e.message) end
  return tostring(e)
end

local function runScenario(sc)
  local legend = {}
  for k, v in pairs(LEGEND) do legend[k] = v end
  for k, v in pairs(sc.legend or {}) do legend[k] = v end
  build(sc.fixture, legend)
  local function state() return (H.call("get_state", {})) end
  local function idsIn(st)
    return function(name)
      for _, l in ipairs(flat(st.activeSprite.layers)) do if l.name == name then return l.id end end
    end
  end
  local function prepare(v)
    if type(v) ~= "table" then return v end
    if v["$id"] then return idsIn(state())(v["$id"]) end
    if v.rows then return base64(rowsToBytes(v.rows, legend)) end
    local out = {}
    for k, x in pairs(v) do out[k] = prepare(x) end
    return out
  end
  for n, step in ipairs(sc.steps) do
    local where = "step " .. n
    local method, params
    if step.request then method, params = step.request, prepare(step.params or {})
    elseif step.pixels then method, params = "snapshot", prepare(step.pixels)
    else method, params = "get_state", {} end
    local res = table.pack(pcall(H.call, method, params))
    if step.error then
      if res[1] then return where .. ": expected an error containing '" .. step.error .. "', got " .. show(res[2]) end
      if not errorText(res[2]):find(step.error, 1, true) then
        return where .. ": expected an error containing '" .. step.error .. "', got '" .. errorText(res[2]) .. "'"
      end
    else
      if not res[1] then return where .. " (" .. method .. "): " .. errorText(res[2]) end
      local ids = idsIn(state())
      local problems = {}
      if step.request and step.result then problems = match(step.result, res[2], ids)
      elseif step.pixels then
        local rows, unknown = bytesToRows(res[3], res[2].width, res[2].height, legend)
        problems = match(step.rows, rows, ids)
        if #unknown > 0 then problems[#problems + 1] = "colors without a legend key: " .. table.concat(unknown, ", ") end
      elseif step.state then problems = match(step.state, normalize(res[2]), ids) end
      if #problems > 0 then return where .. " (" .. method .. "): " .. table.concat(problems, "; ") end
    end
  end
end

local files = {}
for _, f in ipairs(app.fs.listFiles(contractDir)) do
  if f:match("%.json$") and f ~= "legend.json" then files[#files + 1] = f end
end
table.sort(files)
for _, f in ipairs(files) do
  local doc = plain(readJson(app.fs.joinPath(contractDir, f)))
  for _, sc in ipairs(doc.scenarios) do
    local name = "contract " .. f:gsub("%.json$", "") .. ": " .. sc.name
    local ok, problem = pcall(runScenario, sc)
    if not ok then problem = "error: " .. errorText(problem) end
    if problem then
      failures = failures + 1
      print("FAIL " .. name .. " -- " .. problem:gsub("\n", " "))
    else
      passed = passed + 1
      print("PASS " .. name)
    end
  end
end
closeAll()
print(passed .. " scenarios passed")
print(failures == 0 and passed > 0 and "ALL PASSED" or (failures .. " FAILED"))
