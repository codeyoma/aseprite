---
name: aseprite-shade-sprite
title: Shade and outline
description: Turn flat colors into shaded pixel art with hue-shifted ramps, a light direction and an outline (dark, or selout).
category: Color
triggers: [shade, shading, add shadows, light from, outline, selout, color ramp, hue shift]
tools: [make_ramp, shade_sprite, outline_sprite, snapshot, check]
---
# Shade and outline

1. Find the layer (the active one, or the one the user names) and ask nothing you can infer: default light from the top-left, 3 bands, outline in the palette's darkest color.
2. If the user wants the result in the sprite's palette, build ramps first with `make_ramp` (one per main color, `add_to_palette: true`), then shade with `snap_to_palette: true`.
3. Shade with `shade_sprite` (light, bands; `rim: true` for a rim light; `whole_shape: true` when the colors are details on one body rather than separate parts). It writes 'AI: shaded <layer>' and hides the original.
4. Outline with `outline_sprite` when the art has none or the user asks: `color: "selout"` for softer, colored outlines; `mode: "inner"` when the sprite must not grow.
5. `snapshot` and look: if the light reads wrong (e.g. a flat-looking blob), try `whole_shape` or a different number of bands, and show the user the better one (or make variations).
6. Run `check`; reply with the light direction, bands, ramps and outline you used.
