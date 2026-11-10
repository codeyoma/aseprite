---
name: fix-pixel-art
title: Fix AI or upscaled pixel art
description: Turn an AI-generated or upscaled "pixel art" image into a clean sprite at its real resolution, with a tidy palette.
category: Cleanup
triggers: [ai pixel art, upscaled, fake pixel art, downscale, pixel snap, blurry pixels]
needs: [image]
tools: [detect_pixel_grid, fix_pixel_art, check, snapshot]
---
# Fix AI or upscaled pixel art

1. Take the attached image: the message lists it as `[Attached image 1: ..., file <path>]`; pass that path. Call `detect_pixel_grid` and tell the user what you found: the cell size (e.g. "each pixel is about 5.5 px wide") and the native size it implies.
   - Cell 1 means it's already native pixel art, or a photo: say so and stop, unless the user insists (then ask for the scale and pass `cell`).
2. Call `fix_pixel_art`. Leave `max_colors` unset unless the user wants a limit or the result has many near-identical colors; then use 8–32.
3. Look at the preview it returns. If shapes look broken (doubled or missing rows), the grid was off: try `cell` with the detected size ±0.5 and compare.
4. Run `check` on the new sprite. Mention orphan pixels and leftover anti-aliasing, and fix the clear errors with `execute_lua` if the user wants a clean result.
5. Reply with the native size, the number of colors and what you cleaned up.

Then: `check-sprite`, then `shade-sprite` if the result looks flat.
