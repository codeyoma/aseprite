---
name: extract-palette
title: Extract palette
description: Pull the colors out of an image, a layer or the sprite, grouped into shading ramps, find the closest known palette, and set or save it.
category: Color
triggers: [palette, colors used, extract colors, color palette]
tools: [palette_from_image, remap_to_palette]
---
# Extract palette

1. Find the source: an attached image (`source: "file"` with the attachment's path from the message), the selection, a layer, or the whole sprite. If it's unclear, use the attachment if there is one, otherwise the sprite.
2. Call `palette_from_image`. Keep `max_colors` at 32 unless the user asked for a number; for photos or painted images, suggest 8–16.
3. Explain the result briefly: how many colors, the ramps (e.g. "a 4-step blue ramp and 3 skin tones"), near-duplicates worth merging, and the closest palette among the available ones (say "closest among available palettes", with its coverage).
4. Do what the user wants with it, in the same call or a second one: `set_palette: true`, `swatches: true` (a swatch strip on an `AI: palette` layer), or `save_gpl` with a path.
5. Offer the next step: remap a sprite to this palette or to the closest known one (`remap_to_palette`).
