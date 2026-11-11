---
name: aseprite-extract-palette
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
4. Do what the user wants with it, in the same call or a second one: `set_palette: true`, `swatches: true` (a swatch strip on an `AI: palette` layer), or `save` with a path (the extension picks the format: `.gpl` for GIMP and most editors, `.hex` for Lospec, `.pal`, `.act`, `.col`, or `.aseprite`). For a photo or a painted image, `min_share: 0.002` drops anti-aliasing and noise colors before reducing; `ignore_alpha_below` skips soft edges.
5. Offer the next step: remap a sprite to this palette or to the closest known one (`remap_to_palette`).

Then: `match-tone` to remap a sprite to it, or `recolor` for variants.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "palette_from_image", input: { ... } }). Their inputs:
- palette_from_image {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, max_colors?: integer 2-256, method?: "exact"|"median-cut"|"k-means", set_palette?: boolean, swatches?: boolean, save?: string, save_gpl?: string, ignore_alpha_below?: integer 1-255, min_share?: number 0-0.5, compare_with?: [string]}: The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to light), near-duplicate colors, and the closest…
- remap_to_palette {palette?: string, colors?: [string], file?: string, layer?: string, frames?: string|integer|[integer], preserve_ramps?: boolean, set_palette?: boolean}: Recolor a layer or the sprite so it uses only a palette's colors, by perceptual distance (OKLab).
</skill-tools>
