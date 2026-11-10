# Aseprite scripting basics for agents

Read this before editing. Every rule here was checked against Aseprite 1.3.18.

## Workflow

1. `get_state` (document) and `get_context` (what the user selected).
2. Change things with `execute_lua` or `run_command`.
3. `snapshot` after every visual change. Look at it. Fix what is wrong.
4. Use `read_pixels` when exact pixels matter (outlines, small sprites, palette checks). To change a few pixels, edit its rows and send them back with `write_pixels` (same layer, same legend): one undo step, and a typo is refused with its row and column. For the next animation frame, read the last frame's rows, write them into the new frame, then change only what moves, so shapes keep their size.

Each `execute_lua` call is one undo step. If the code raises an error, everything it did is rolled back, so a failed attempt leaves no partial changes.

## The state block

Chat messages start with an `<aseprite-state>` block: sprite size and color mode, palette, layers from top to bottom with ids such as `L12`, tags, the active layer, frame and cel, and the timeline and pixel selection. Ids stay the same for the whole session. Inside `execute_lua`, `layerById("L12")` returns that layer (it also accepts a layer name).

## Where new content goes

Put content you generate or redraw on a new layer, so the user's pixels stay untouched: `aiLayer(task, prompt)` (in `execute_lua`) creates a layer named `AI: <task>` above the active layer, stores the user's request on it and makes it active. Edit the user's own layers in place only when they ask for that ("recolor this layer", "fix these pixels").

```lua
local l = aiLayer("Shadow", "add a drop shadow under the hero")
app.useTool{ tool = "pencil", color = Color(0, 0, 0), points = { Point(4, 12), Point(9, 12) } }  -- draws on l
```

When the user asks for variations or options ("give me 3 swords"), build each candidate with `variationLayer(task, i)`, which returns a layer `AI: <task> v<i>` inside a group `AI variations: <task>` (only the newest one is visible). Then call `propose_variations(task)`: the user sees thumbnails in the chat panel and keeps one or discards them all. Don't pick for them.

```lua
local l = variationLayer("sword", 2)  -- candidate 2
app.sprite:newCel(l, app.frame, img, Point(0, 0))
```

## Timeline as text

For frame counts, durations, tags and linked cels, use `get_timeline_text` and `apply_timeline_text` instead of Lua. Read the text, edit it, apply it: one call, one undo step.

```
frames 12
frame 1-4 duration 100ms
frame 5-12 duration 80ms
tag idle 1-4 ping-pong
tag walk 5-12 forward repeat=2
layer Shadow link 5-12
```

- `frames N` adds copies of the last frame or removes frames from the end. Draw new content with Lua afterwards.
- `fps N` sets every frame; a later `frame A-B duration` line overrides a range.
- Tags not listed are removed, so start from `get_timeline_text`.
- `layer NAME link A-B` links the cels to the one in A; `unlink A-B` gives each its own copy. Quote names with spaces: `layer "Back arm" link 1-4`.
- `plan: true` returns the changes without applying them. Errors name the line.

## Mentions and links

Users can mention objects; you receive them as `Body (aseprite://layer/L12)`. The scheme:

| URI | Object |
|---|---|
| `aseprite://layer/L12` | layer (id from the state block) |
| `aseprite://frame/3` | frame (1-based) |
| `aseprite://tag/walk` | tag (URL-encoded name) |
| `aseprite://cel/L12:3` | cel of a layer in a frame |
| `aseprite://palette/5` | palette entry (0-based) |
| `aseprite://slice/hitbox` | slice |
| `aseprite://selection` | the pixel selection |

When you mention an object in a reply, write a markdown link such as `[Body](aseprite://layer/L12)`; the chat shows it as a link that selects the object.

## Object model

| Object | Meaning | Access |
|---|---|---|
| Sprite | The document | `app.sprite`, `Sprite(w, h)`, `Sprite(w, h, ColorMode.INDEXED)`, `app.open(path)` |
| Layer | A stacked sheet; can be a group | `sprite.layers` (bottom to top), `sprite:newLayer()`, `sprite:newGroup()` |
| Frame | One step of the animation | `sprite.frames` (1-based), `frame.duration` in **seconds** |
| Cel | The image of one layer in one frame | `layer:cel(frame)`, `sprite:newCel(layer, frame, image, Point(x, y))` |
| Tag | A named frame range | `sprite:newTag(from, to)`, `tag.name`, `tag.aniDir = AniDir.PING_PONG` |
| Palette | Colors of the sprite | `sprite.palettes[1]`, `palette:getColor(i)` (0-based), `palette:resize(n)` |
| Image | Pixel buffer | `Image(w, h)`, `image:clone()`, `image:drawPixel(x, y, color)` |

## Rules that prevent bugs

- **Frames and layer indices are 1-based. Palette indices are 0-based.**
- `sprite.layers[1]` is the **bottom** layer. Move a layer with `layer.stackIndex = n`. Put a layer in a group with `layer.parent = group`.
- **Edit cel images undoably.** `drawPixel` / `putPixel` directly on `cel.image` are not recorded in undo history. Do this instead:
  ```lua
  local cel = layer:cel(frame)
  local img = cel.image:clone()
  img:drawPixel(x - cel.position.x, y - cel.position.y, color)
  cel.image = img
  ```
- **Cel images are trimmed and offset.** Aseprite shrinks cel images to their content, and `cel.position` is the image's top-left in sprite coordinates. Convert sprite coordinates with `x - cel.position.x`. To draw anywhere on a layer, create a full-size image: `local img = Image(sprite.width, sprite.height)`, draw, then `sprite:newCel(layer, frame, img, Point(0, 0))`.
- **Colors:** `Color(r, g, b)` or `Color(r, g, b, a)`. `Color("#ff0000")` does **not** parse hex (it gives black). In indexed sprites, `Color{ index = n }` refers to a palette entry.
- **Commands:** `app.command.Name{ ui = false, ... }`. Always pass `ui = false`; otherwise a modal dialog blocks until the user closes it. Commands return `true` if they ran. Prefer `run_command` with `list_commands` to discover parameters.
- **Commands act on the active objects.** Set `app.sprite`, `app.layer`, `app.frame` first. Filters (Outline, ReplaceColor, HueSaturation, ...) change only the active layer's cel in the active frame, so loop over frames to apply them everywhere.
- **Tools:** `app.useTool{ tool = "pencil", color = Color(...), brush = Brush(1), points = { Point(x, y), ... }, layer = layer, frame = frame }`. Tool ids include `pencil`, `eraser`, `line`, `rectangle`, `filled_rectangle`, `ellipse`, `filled_ellipse`, `paint_bucket`, `spray`. Direct image edits are usually more precise than `useTool`.
- **Workspace and panels:** switch layouts with `run_command SetWorkspaceLayout { layout = "default" | "mirrored" }`. Toggle panels and views with `Timeline`, `PaletteEditor`, `ShowGrid`, `ShowOnionSkin`, `ToggleWorkspaceLayout`, `FullscreenPreview`.
- `app.transaction` needs an open sprite. When no sprite is open, `execute_lua` runs without one (no undo step).
- Code that opens files (`app.open`), changes the active sprite, or calls `app.undo` should run with `transaction = false`.
- `sprite:newFrame(n)` inserts a **copy** of frame `n` at position `n` (the original moves to `n + 1`). `sprite:newEmptyFrame(n)` inserts an empty frame.
- Return values come back as JSON. Return plain tables: `return { width = s.width }`.

## Color modes

- **RGB:** any color per pixel. Easiest for drawing.
- **Indexed:** each pixel is a palette index. Best for strict pixel art. Convert with `run_command ChangePixelFormat { format = "indexed" }` after building the palette (see recipes).
- **Grayscale:** values only.

Check `get_state().activeSprite.colorMode` before drawing. In indexed mode, draw with colors that exist in the palette.
