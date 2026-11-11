---
name: aseprite-recolor
title: Recolor and team colors
description: Make palette-swapped versions of a sprite (team colors, enemy tiers, status effects) that keep the shading, and export a palette-swap table for shaders.
category: Color
triggers: [recolor, palette swap, team colors, color variants, red version, blue version, alternate colors, lut]
tools: [palette_from_image, make_ramp, palette_swap, export_palette_lut, snapshot]
---
# Recolor and team colors

1. Find the colors to change: `palette_from_image` on the layer shows the ramps (e.g. the shirt's 3 blues, dark to light). Change ramps, not single colors, so shading stays.
2. For each variant, pick the target ramp: from the palette (same number of steps, dark to light), or build one with `make_ramp` from a base color (e.g. `#ff004d` with the same number of steps).
3. Call `palette_swap` with one variant per version: `{ name: "red team", from: [the blues], to: [the reds] }`. Leave skin, outline and other parts alone unless asked.
4. `snapshot` each variant layer (hide the others) and check the shading still reads; reply with the variants and their ramps.
5. For games that swap palettes in a shader, `export_palette_lut` writes an index map, a lookup table (one row per variant) and a Godot shader.

Then: `export-game`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "palette_from_image", input: { ... } }). Their inputs:
- palette_from_image {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, max_colors?: integer 2-256, method?: "exact"|"median-cut"|"k-means", set_palette?: boolean, swatches?: boolean, save?: string, save_gpl?: string, ignore_alpha_below?: integer 1-255, min_share?: number 0-0.5, compare_with?: [string]}: The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to light), near-duplicate colors, and the closest…
- make_ramp {base: string, steps?: integer 2-9, hue_shift?: number 0-90, add_to_palette?: boolean}: A pixel-art color ramp through a base color, dark to light, with hue shifting (shadows turn cool toward blue/purple, highlights warm toward yellow) and softe…
- palette_swap {layer?: string, frames?: string|integer|[integer], variants: [object]}: Make recolored variants of a layer (team colors, enemy versions, status effects): each variant maps colors (single colors with `map`, or a whole ramp `from` …
- export_palette_lut {layer?: string, frame?: integer, variants: [object], dir: string, name?: string}: Export palette-swap data for a shader: <name>_index.png (each pixel's index into the base palette in the red channel) and <name>_lut.png (row 0 the base pale…
</skill-tools>
