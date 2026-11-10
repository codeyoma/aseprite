# Recipes

Each recipe is one `execute_lua` call unless noted. Find layers by name, not by index: indices change when layers are added.

```lua
-- Find a layer by name, including inside groups.
local function findLayer(layers, name)
  for _, l in ipairs(layers) do
    if l.name == name then return l end
    if l.isGroup then local f = findLayer(l.layers, name); if f then return f end end
  end
end
```

Recipes below inline this helper where they need it. Change the values at the top. All recipes are tested in `agent/tests/recipes_test.lua`.

## New sprite with named layers

```lua
-- recipe: new-sprite
local W, H = 32, 32
local s = Sprite(W, H)
s.layers[1].name = "Body"
local shadow = s:newLayer(); shadow.name = "Shadow"; shadow.stackIndex = 1  -- below Body
local outline = s:newLayer(); outline.name = "Outline"                    -- on top
return { layers = #s.layers }
```

## Add a layer below another and set its opacity

```lua
-- recipe: layer-below
local TARGET = "Body"
local s = app.sprite
local target
for _, l in ipairs(s.layers) do if l.name == TARGET then target = l end end
if not target then error("No layer named " .. TARGET) end
local l = s:newLayer()
l.name = "Glow"
l.stackIndex = target.stackIndex            -- takes target's slot; target moves up
l.opacity = 128                             -- 0-255 (50%)
return { below = target.name, index = l.stackIndex }
```

## Draw on a layer (undoable)

```lua
-- recipe: draw-circle
local LAYER, FRAME = "Body", 1
local s = app.sprite
local layer
for _, l in ipairs(s.layers) do if l.name == LAYER then layer = l end end
if not layer then error("No layer named " .. LAYER) end
local frame = FRAME
local img = Image(s.width, s.height)        -- full-size buffer, transparent
local old = layer:cel(frame)
if old then img:drawImage(old.image, old.position) end  -- keep existing pixels
local cx, cy, r = s.width / 2 - 0.5, s.height / 2 - 0.5, math.min(s.width, s.height) / 3
for y = 0, s.height - 1 do
  for x = 0, s.width - 1 do
    local dx, dy = x - cx, y - cy
    if dx * dx + dy * dy <= r * r then img:drawPixel(x, y, Color(220, 60, 60)) end
  end
end
s:newCel(layer, frame, img, Point(0, 0))
return "ok"
```

## Turn an image into pixel art

Run with `transaction = false`, because it opens a file.

```lua
-- recipe: pixelate
local PATH = "/path/to/image.png"
local W, H = 32, 32          -- target size (keep the aspect ratio)
local COLORS = 16
local s = app.open(PATH)
if not s then error("Could not open " .. PATH) end
app.sprite = s
if s.colorMode ~= ColorMode.RGB then app.command.ChangePixelFormat{ ui = false, format = "rgb" } end
app.command.SpriteSize{ ui = false, width = W, height = H, lockRatio = false, method = "bilinear" }
app.command.ColorQuantization{ ui = false, maxColors = COLORS, withAlpha = true }
app.command.ChangePixelFormat{ ui = false, format = "indexed" }   -- no dithering = clean pixel art
return { width = s.width, height = s.height, colors = #s.palettes[1] }
```

Downscaling with `bilinear` averages detail; then quantization picks the palette. For a crisper, posterized look, use `method = "nearest"`. Add `dithering = "ordered"` to `ChangePixelFormat` for a retro dithered look.

## Retime: double the frame count (10 → 20) without changing speed

```lua
-- recipe: retime-double
local s = app.sprite
local n = #s.frames
for i = n, 1, -1 do
  local d = s.frames[i].duration
  s:newFrame(i)                              -- copy of frame i inserted at i
  s.frames[i].duration = d / 2
  s.frames[i + 1].duration = d / 2
end
return { frames = #s.frames }
```

This duplicates frames (holds). To make real in-between drawings, edit the inserted copies afterwards.

## Change animation speed

```lua
-- recipe: set-fps
local FPS = 12
for _, f in ipairs(app.sprite.frames) do f.duration = 1 / FPS end
return { fps = FPS }
```

## Idle bob animation from one frame

```lua
-- recipe: idle-bob
local LAYER = "Body"
local s = app.sprite
local layer
for _, l in ipairs(s.layers) do if l.name == LAYER then layer = l end end
if not layer then error("No layer named " .. LAYER) end
local OFFSETS = { 0, -1, -1, 0 }             -- vertical offset per frame
local base = layer:cel(1)
if not base then error("Layer " .. layer.name .. " has no cel in frame 1") end
while #s.frames < #OFFSETS do s:newEmptyFrame(#s.frames + 1) end
for i, dy in ipairs(OFFSETS) do
  s.frames[i].duration = 0.15
  if i > 1 then
    s:newCel(layer, i, base.image, Point(base.position.x, base.position.y + dy))
  end
end
local tag = s:newTag(1, #OFFSETS)
tag.name = "idle"
return { frames = #s.frames, tag = tag.name }
```

## Tags

```lua
-- recipe: tags
local s = app.sprite
local walk = s:newTag(1, math.min(4, #s.frames)); walk.name = "walk"
walk.aniDir = AniDir.FORWARD                -- FORWARD, REVERSE, PING_PONG
return { tags = #s.tags }
```

## Outline a layer

Filters like Outline act on the active layer and frame only, so loop over the frames.

```lua
-- recipe: outline
local s = app.sprite
for _, l in ipairs(s.layers) do if l.name == "Body" then app.layer = l end end
local done = 0
for _, f in ipairs(s.frames) do
  if app.layer:cel(f) then
    app.frame = f
    app.command.Outline{ ui = false, color = Color(20, 20, 30), place = "outside", matrix = "circle" }
    done = done + 1
  end
end
return { framesOutlined = done }
```

## Export a sprite sheet with JSON

Run with `transaction = false`.

```lua
-- recipe: export-sheet
local OUT = "/path/to/sheet"           -- writes sheet.png and sheet.json
app.command.ExportSpriteSheet{
  ui = false,
  type = "horizontal",            -- horizontal, vertical, rows, columns, packed
  textureFilename = OUT .. ".png",
  dataFilename = OUT .. ".json",
  dataFormat = "json-array",
  listTags = true,
}
return { png = OUT .. ".png", json = OUT .. ".json" }
```

## Save

```lua
-- recipe: save
local PATH = "/path/to/sprite.aseprite"
app.sprite:saveAs(PATH)          -- .aseprite keeps layers/frames; .png/.gif export a flattened image
return PATH
```
