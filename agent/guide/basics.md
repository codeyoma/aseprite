# Aseprite scripting basics for agents

Read this before editing. Every rule here was checked against Aseprite 1.3.18.

## Workflow

1. `get_state` (document) and `get_context` (what the user selected).
2. Change things with `execute_lua` or `run_command`.
3. `snapshot` after every visual change. Look at it. Fix what is wrong.
4. Use `read_pixels` when exact pixels matter (outlines, small sprites, palette checks).

Each `execute_lua` call is one undo step. If the code raises an error, everything it did is rolled back, so a failed attempt leaves no partial changes.

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
- `app.transaction` needs an open sprite. When no sprite is open, `execute_lua` runs without one (no undo step).
- Code that opens files (`app.open`), changes the active sprite, or calls `app.undo` should run with `transaction = false`.
- `sprite:newFrame(n)` inserts a **copy** of frame `n` at position `n` (the original moves to `n + 1`). `sprite:newEmptyFrame(n)` inserts an empty frame.
- Return values come back as JSON. Return plain tables: `return { width = s.width }`.

## Color modes

- **RGB:** any color per pixel. Easiest for drawing.
- **Indexed:** each pixel is a palette index. Best for strict pixel art. Convert with `run_command ChangePixelFormat { format = "indexed" }` after building the palette (see recipes).
- **Grayscale:** values only.

Check `get_state().activeSprite.colorMode` before drawing. In indexed mode, draw with colors that exist in the palette.
