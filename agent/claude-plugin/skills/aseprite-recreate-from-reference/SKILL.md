---
name: aseprite-recreate-from-reference
title: Recreate from a reference image
description: Rebuild a screenshot or sprite you attach as an editable sprite (native pixels, palette, frames, layers by color) and learn its style to draw new art like it.
category: Import
triggers: [recreate, reference image, from this screenshot, copy this sprite, in this style, same style as]
needs: [image]
tools: [recreate_from_reference, detect_background, find_sprites, style_summary, split_by_color, palette_from_image, remap_to_palette, check]
---
# Recreate from a reference image

Work only from images the user attached; don't look for art on the web. Say once, briefly, that art recreated from other games is for study and personal use unless they hold the rights.

**Recreate it**
1. Call `recreate_from_reference` with the attachment's path. It removes the background, undoes the screenshot's scaling, finds the poses (several similar ones become frames, rows become tags), sets the palette and splits the layer by color role.
2. If the poses came apart or merged wrong, retry with `merge_distance` or `frames: "single"`; if the scale is wrong, pass `cell`.
3. To cut sprites out without recreating them (a screenshot or a loose sheet), use `find_sprites`: it lists the boxes, and `as: "frames"` or `as: "layers"` cuts them out. `detect_background` reports or removes just the background (key color, checkerboard, transparent).
4. `snapshot` the result and tell the user what it is: size, frames, colors, layers, and the style summary in two or three sentences (outline, shading steps, dithering).

**Draw something new in its style**
1. Get the rules with `style_summary` (on the attachment's path, or on the recreated sprite).
2. Draw on a new layer in a new sprite of about the same size: set the reference's colors as the palette first, follow the outline and shading rules.
3. Afterwards, `remap_to_palette` with `palette: "sprite"` so no stray colors remain, `check`, and `snapshot`. Compare with the reference and say how closely it follows the rules.

Then: `check-sprite`, then `review`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "recreate_from_reference", input: { ... } }). Their inputs:
- recreate_from_reference {path: string, cell?: number 1-64, frames?: "auto"|"single", merge_distance?: integer 0-32, row_tags?: [string], split_layers?: boolean, name?: string}: Rebuild a reference image the user attached (a screenshot or sprite) as an editable sprite: makes the background transparent, detects the scale and returns t…
- detect_background {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, remove?: boolean, tolerance?: integer 0-64, out?: string}: Find the background of an image (a PNG such as an attachment, the sprite, or a layer) from its border: transparent, one key color, or a checkerboard (a scree…
- find_sprites {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, merge_distance?: integer 0-32, min_pixels?: integer, as?: "list"|"frames"|"layers", row_tags?: [string], name?: string}: Find the separate sprites in an image (a PNG such as a screenshot or a loose sheet, the sprite, or a layer): removes the background (key color, checkerboard …
- style_summary {path?: string, layer?: string, frame?: integer}: How a sprite or a reference image is built: size, colors and ramps (shading steps), outline (one dark color, selout, or none), dithering, with rules to follo…
- split_by_color {layer?: string}: Split a layer into editable layers by color role, across all frames: the outline on one layer and each color ramp (by hue) on its own; pixels that fit no gro…
- palette_from_image {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, max_colors?: integer 2-256, method?: "exact"|"median-cut"|"k-means", set_palette?: boolean, swatches?: boolean, save?: string, save_gpl?: string, ignore_alpha_below?: integer 1-255, min_share?: number 0-0.5, compare_with?: [string]}: The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to light), near-duplicate colors, and the closest…
- remap_to_palette {palette?: string, colors?: [string], file?: string, layer?: string, frames?: string|integer|[integer], preserve_ramps?: boolean, set_palette?: boolean}: Recolor a layer or the sprite so it uses only a palette's colors, by perceptual distance (OKLab).
</skill-tools>
