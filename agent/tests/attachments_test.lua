-- Attachments (#21): selection, layer and frame render to upscaled PNGs.
--   aseprite -b --script-param ext=<agent/extension> --script-param tmp=<dir> --script agent/tests/attachments_test.lua
local extDir, tmp = app.params.ext, app.params.tmp
local P = (function()
  local f = assert(io.open(app.fs.joinPath(extDir, "protocol.json")))
  local p = json.decode(f:read("a")); f:close(); return p
end)()
local H = dofile(app.fs.joinPath(extDir, "document_handlers.lua")).new{ chunkDir = extDir, protocol = P }
local A = dofile(app.fs.joinPath(extDir, "attachments.lua")).new{ dir = tmp, snapshot = H.snapshot, Uri = H.Uri,
  writeImage = function(img, path) img:saveAs(path) end }

local failures = 0
local function check(name, cond, detail)
  if cond then print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end

check("no sprite", select(2, A:make("frame")) == "Open a sprite first")

local sprite = Sprite(32, 16, ColorMode.RGB)
app.useTool{ tool = "pencil", color = Color(0, 255, 0), points = { Point(5, 5) } }
check("empty selection", select(2, A:make("selection")) == "Select an area first")

sprite.selection = Selection(Rectangle(4, 4, 4, 2))
local a = A:make("selection")
check("selection label", a and a.label == "selection 4x2 at 4,4 (frame 1)", a and a.label)
local img = a and Image{ fromFile = a.path }
check("selection upscaled to 512", img and img.width == 512 and img.height == 256, img and img.width)
check("selection pixel", img and app.pixelColor.rgbaG(img:getPixel(128 + 1, 128 + 1)) == 255)
check("selection uri", a and a.uri == "aseprite://selection")

local f = A:make("frame")
local fi = f and Image{ fromFile = f.path }
check("frame", f and f.label == "frame 1" and fi.width == 512 and fi.height == 256, f and f.label)

local l = A:make("layer")
check("layer", l and l.label == "layer Layer 1 (frame 1)" and l.uri:match("^aseprite://layer/L%d+$"), l and l.label)

check("file", A:file(a.path).label:match("^image ") ~= nil)
check("file type", select(2, A:file(app.fs.joinPath(tmp, "x.txt"))) == "Attach a PNG, JPEG, GIF or WebP image")

print(failures == 0 and "ALL PASSED" or (failures .. " FAILED"))
