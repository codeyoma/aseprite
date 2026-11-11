---
name: aseprite-shade-sprite
title: Shade and outline
description: Turn flat colors into shaded pixel art with hue-shifted ramps, a light direction and an outline (dark, or selout).
category: Color
triggers: [shade, shading, add shadows, light from, outline, selout, color ramp, hue shift, anti-alias, antialias, jaggies, ambient occlusion, ao]
tools: [make_ramp, shade_sprite, outline_sprite, anti_alias, ambient_occlusion, snapshot, check]
---
# Shade and outline

1. Find the layer (the active one, or the one the user names) and ask nothing you can infer: default light from the top-left, 3 bands, outline in the palette's darkest color.
2. If the user wants the result in the sprite's palette, build ramps first with `make_ramp` (one per main color, `add_to_palette: true`), then shade with `snap_to_palette: true`.
3. Shade with `shade_sprite` (light, bands; `rim: true` for a rim light; `whole_shape: true` when the colors are details on one body rather than separate parts). It writes 'AI: shaded <layer>' and hides the original.
4. Outline with `outline_sprite` when the art has none or the user asks: `color: "selout"` for softer, colored outlines; `mode: "inner"` when the sprite must not grow.
5. Finishing touches when asked or when it clearly helps: `ambient_occlusion` darkens creases and where parts meet (from a bevel of the shape, or a height layer the user painted); `anti_alias` softens jagged steps between line art and fill with in-between colors from the palette. Both go on their own `AI:` layers, so the user can toggle them.
6. `snapshot` and look: if the light reads wrong (e.g. a flat-looking blob), try `whole_shape` or a different number of bands, and show the user the better one (or make variations).
7. Run `check`; reply with the light direction, bands, ramps and outline you used.

Then: `review`, or `animate` when it should move.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "make_ramp", input: { ... } }). Their inputs:
- make_ramp {base: string, steps?: integer 2-9, hue_shift?: number 0-90, add_to_palette?: boolean}: A pixel-art color ramp through a base color, dark to light, with hue shifting (shadows turn cool toward blue/purple, highlights warm toward yellow) and softe…
- shade_sprite {layer?: string, frames?: string|integer|[integer], light?: "top-left"|"top"|"top-right"|"left"|"right"|"bottom-left"|"bottom"|"bottom-right", bands?: integer 2-5, rim?: boolean, whole_shape?: boolean, snap_to_palette?: boolean}: Shade a flat-colored layer: each flat color becomes a small hue-shifted ramp, and every pixel takes a step from the shape's estimated form lit from `light`.
- outline_sprite {layer?: string, frames?: string|integer|[integer], mode?: "outer"|"inner", connectivity?: 4|8, color?: string}: Outline a layer's shapes: outer (around them) or inner (their edge pixels), 4-connected (rounder, usual) or 8-connected, in one color, 'darkest' (the palette…
- anti_alias {layer?: string, frames?: string|integer|[integer], strength?: number 0.2-1, snap_to_palette?: boolean}: Manual anti-aliasing: in each jagged step between two colors inside a layer (line art against fill, one shade against the next), the pixel in the step's inne…
- ambient_occlusion {layer?: string, frames?: string|integer|[integer], height_layer?: string, source?: "bevel"|"luminance", radius?: integer 1-8, levels?: integer 1-3, strength?: number 0.2-3, as_mask?: boolean}: Darken creases and contact areas: occlusion from a height field (a grayscale 'height_layer', or one made from the shape: 'bevel' rounds from the silhouette, …
</skill-tools>
