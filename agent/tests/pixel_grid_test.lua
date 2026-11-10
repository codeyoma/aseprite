-- Writable pixel grid (#74): read_pixels -> write_pixels round trips give
-- identical pixels (RGB and indexed), a write is one undo step that keeps
-- the cel's position, and mistakes are refused with their row and column.
-- Run: aseprite -b --script-param ext=<agent/extension> --script agent/tests/pixel_grid_test.lua
local extDir = app.params.ext
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

-- Every pixel of a layer in a frame, in sprite coordinates ("" when it has no cel).
local function pixelsOf(layer, frame)
  local cel = layer:cel(frame)
  if not cel then return "" end
  local out = {}
  for it in cel.image:pixels() do
    local v = it()
    if v ~= (cel.image.colorMode == ColorMode.INDEXED and cel.sprite.transparentColor or 0) then
      out[#out + 1] = (it.x + cel.position.x) .. "," .. (it.y + cel.position.y) .. "=" .. v
    end
  end
  table.sort(out)
  return table.concat(out, " ")
end

local function roundTrip(mode, label)
  local s = Sprite(12, 8, mode)
  app.command.NewFrame()
  app.frame = s.frames[1]
  local layer = s.layers[1]
  if mode == ColorMode.INDEXED then
    local pal = Palette(6)
    for i, c in ipairs({ "#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff" }) do
      local r, g, b = tonumber(c:sub(2, 3), 16), tonumber(c:sub(4, 5), 16), tonumber(c:sub(6, 7), 16)
      pal:setColor(i - 1, Color(r, g, b))
    end
    s:setPalette(pal)
  end
  -- A pattern of colors (and, in RGB, a half-transparent one) in a cel at (2, 1).
  local img = Image(7, 5, mode)
  for y = 0, 4 do
    for x = 0, 6 do
      local k = (x * 3 + y * 5) % 6
      if k > 0 then
        if mode == ColorMode.INDEXED then img:drawPixel(x, y, k)
        else
          local colors = { { 255, 0, 0, 255 }, { 0, 255, 0, 255 }, { 0, 0, 255, 255 }, { 255, 255, 0, 255 }, { 255, 0, 255, 128 } }
          local c = colors[k]
          img:drawPixel(x, y, app.pixelColor.rgba(c[1], c[2], c[3], c[4]))
        end
      end
    end
  end
  s:newCel(layer, 1, img, Point(2, 1))
  for i = 2, 2 do if layer:cel(i) then s:deleteCel(layer, i) end end
  local original = pixelsOf(layer, 1)

  local read = H.call("read_pixels", { layer = layer.name, frame = 1 })
  local legend = read.legend
  -- Back into the same frame: nothing changes, no undo step.
  local steps = s.undoHistory.undoSteps
  local same = H.call("write_pixels", { layer = layer.name, frame = 1, rows = read.rows, legend = legend })
  check(label .. ": same rows change nothing", same.changed == 0 and pixelsOf(layer, 1) == original, same.changed)
  check(label .. ": no undo step for no change", s.undoHistory.undoSteps == steps)
  -- Into the empty next frame: identical pixels, the cel covers only painted pixels.
  local next = H.call("write_pixels", { layer = layer.name, frame = 2, rows = read.rows, legend = legend })
  check(label .. ": round trip into frame 2 is identical", pixelsOf(layer, 2) == original, pixelsOf(layer, 2))
  check(label .. ": new cel at the painted bounds", next.cel.x == layer:cel(1).position.x and next.cel.y == 1, json.encode(next.cel))
  check(label .. ": one undo step", s.undoHistory.undoSteps == steps + 1)
  -- A changed pixel, then undo: back to the original.
  local rows = {}
  for i, r in ipairs(read.rows) do rows[i] = r end
  rows[3] = rows[3]:gsub("%S+", ".")
  H.call("write_pixels", { layer = layer.name, frame = 1, rows = rows, legend = legend })
  check(label .. ": edit changed frame 1", pixelsOf(layer, 1) ~= original)
  app.undo()
  check(label .. ": one undo restores it", pixelsOf(layer, 1) == original)
  return s, layer
end

local s, layer = roundTrip(ColorMode.RGB, "rgb")
roundTrip(ColorMode.INDEXED, "indexed")

-- The cel grows to cover painted pixels outside it and keeps its pixels in place.
app.sprite = s
app.frame = s.frames[1]
local before = pixelsOf(layer, 1)
local cel = layer:cel(1)
local ox, oy = cel.position.x, cel.position.y
H.call("write_pixels", { layer = layer.name, frame = 1, x = 0, y = 0, rows = { "r" }, legend = { r = "#ff0000" } })
cel = layer:cel(1)
check("cel grows to x=0 y=0", cel.position.x == 0 and cel.position.y == 0 and cel.image.width == ox + 7, cel.bounds)
local want = {}
for item in before:gmatch("%S+") do want[#want + 1] = item end
want[#want + 1] = "0,0=" .. app.pixelColor.rgba(255, 0, 0, 255)
table.sort(want)
check("old pixels stay in place", pixelsOf(layer, 1) == table.concat(want, " "), oy)

-- Errors name the row and the column, and leave the sprite alone.
local function err(params)
  local ok, e = pcall(H.call, "write_pixels", params)
  return not ok and tostring(e) or ""
end
local snap = pixelsOf(layer, 1)
local e = err{ layer = layer.name, rows = { ". r", "r" }, legend = { r = "#ff0000" } }
check("ragged row names row 2", e:find("Row 2 (y=1) has 1 pixels but row 1 has 2", 1, true), e)
e = err{ layer = layer.name, x = 3, y = 2, rows = { "r r", "r q" }, legend = { r = "#ff0000" } }
check("unknown key names row and column", e:find("Row 2, column 2 (x=4, y=3): unknown key 'q'", 1, true), e)
e = err{ layer = layer.name, x = 11, rows = { "r r" }, legend = { r = "#ff0000" } }
check("off-canvas pixel is refused", e:find("Row 1, column 2 (x=12, y=0) is outside the 12x8 canvas", 1, true), e)
check("errors change nothing", pixelsOf(layer, 1) == snap)
local group = s:newGroup()
e = err{ layer = group.name, rows = { "r" }, legend = { r = "#ff0000" } }
check("a group is refused", e:find("is not one", 1, true), e)

print(failures == 0 and "ALL PASS" or (failures .. " FAILED"))
if failures > 0 then error(failures .. " failures") end
