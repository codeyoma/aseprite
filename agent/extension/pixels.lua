-- Pixels and colors for the document handlers (#56): hex colors, RGB
-- images from any color mode, walking a cel's pixels, and base64. One
-- formatter and one parser for hex colors.

local M = {}

-- "#rrggbb", or "#rrggbbaa" when not opaque.
function M.hex(r, g, b, a)
  if a == nil or a >= 255 then return string.format("#%02x%02x%02x", r, g, b) end
  return string.format("#%02x%02x%02x%02x", r, g, b, a)
end

-- A Color as hex.
function M.colorHex(c)
  return M.hex(c.red, c.green, c.blue, c.alpha)
end

-- "#rrggbb" or "#rrggbbaa" (# optional) to r, g, b, a.
function M.parseHex(hex)
  local h = tostring(hex):gsub("^#", "")
  if not h:match("^%x+$") or (#h ~= 6 and #h ~= 8) then
    error("Invalid color: " .. tostring(hex) .. " (use #rrggbb or #rrggbbaa)")
  end
  local n = function(i) return tonumber(h:sub(i, i + 1), 16) end
  return n(1), n(3), n(5), #h == 8 and n(7) or 255
end

-- Hex to a Color.
function M.color(hex)
  return Color(M.parseHex(hex))
end

-- An RGB image of any image. A tilemap image (tile indexes) is drawn through
-- its layer's tileset, so the result is the tiles' size, not the map's.
function M.toRgbImage(src, palette, tileset)
  if src.colorMode == ColorMode.RGB then return src end
  if ColorMode.TILEMAP and src.colorMode == ColorMode.TILEMAP then
    if not tileset then error("A tilemap image needs its tileset") end
    local size = tileset.grid.tileSize
    local dst = Image(src.width * size.width, src.height * size.height, ColorMode.RGB)
    for it in src:pixels() do
      -- Tile index 0 is the empty tile.
      local i = app.pixelColor.tileI(it())
      local tile = i > 0 and tileset:getTile(i)
      if tile then dst:drawImage(M.toRgbImage(tile, palette), Point(it.x * size.width, it.y * size.height)) end
    end
    return dst
  end
  local dst = Image(src.width, src.height, ColorMode.RGB)
  if src.colorMode == ColorMode.INDEXED then
    local mask = src.spec.transparentColor
    for it in src:pixels() do
      local idx = it()
      if idx ~= mask and idx < #palette then
        local c = palette:getColor(idx)
        dst:drawPixel(it.x, it.y, app.pixelColor.rgba(c.red, c.green, c.blue, c.alpha))
      end
    end
  elseif src.colorMode == ColorMode.GRAYSCALE then
    local pc = app.pixelColor
    for it in src:pixels() do
      local v = it()
      local g, a = pc.grayaV(v), pc.grayaA(v)
      dst:drawPixel(it.x, it.y, pc.rgba(g, g, g, a))
    end
  end
  return dst
end

-- Calls fn(x, y, r, g, b, a) for every pixel of a cel, in sprite coordinates.
function M.eachPixel(cel, palette, fn)
  local l = cel.layer
  local img = M.toRgbImage(cel.image, palette, l.isTilemap and l.tileset or nil)
  local pc = app.pixelColor
  local ox, oy = cel.position.x, cel.position.y
  for it in img:pixels() do
    local v = it()
    fn(it.x + ox, it.y + oy, pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v))
  end
end

local B64 = {}
do
  local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for i = 1, #chars do B64[chars:byte(i)] = i - 1 end
end
function M.base64Decode(s)
  local out, n = {}, 0
  local bits, nbits = 0, 0
  local chunk = {}
  for i = 1, #s do
    local v = B64[s:byte(i)]
    if v then
      bits = (bits << 6) | v
      nbits = nbits + 6
      if nbits >= 8 then
        nbits = nbits - 8
        n = n + 1
        chunk[n] = (bits >> nbits) & 0xFF
        if n == 4096 then
          out[#out + 1] = string.char(table.unpack(chunk, 1, n))
          n = 0
        end
      end
    end
  end
  if n > 0 then out[#out + 1] = string.char(table.unpack(chunk, 1, n)) end
  return table.concat(out)
end

return M
