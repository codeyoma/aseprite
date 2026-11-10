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
