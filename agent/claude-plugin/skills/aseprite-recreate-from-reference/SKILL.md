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
