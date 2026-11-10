---
name: aseprite-normal-map
title: Normal maps and lighting
description: Make normal maps and emission/specular masks so sprites react to 2D lights in Godot or Unity, preview them under lights, and export color, normal and mask sheets.
category: Lighting
triggers: [normal map, normalmap, normals, 2d lighting, dynamic lighting, lit sprite, emission mask, specular mask, glow map]
tools: [normal_map, make_masks, light_preview, export_normal_sheet, snapshot]
---
# Normal maps and lighting

1. Pick the height source:
   - **bevel** (default): rounded edges from the silhouette; good for round objects, characters and props.
   - **luminance**: the sprite's own shading becomes height; good when the art is already shaded from the front.
   - **height**: the user (or you) paints a grayscale height layer (white = high); best control.
2. Call `normal_map` on the layer (all frames). It goes on a hidden 'AI: normal <layer>' layer; `levels` 2–3 keeps the pixel look, 0 is smooth. Ask which engine: Godot and Unity use OpenGL (the default); DirectX engines need `convention: "directx"`.
3. If parts glow or shine, call `make_masks` (hidden 'AI: emission <layer>' / 'AI: specular <layer>' layers):
   - **emission**: lamps, eyes, magic. The default picks bright, saturated pixels; pass `emission.colors` (hex) when you know them, or `emission.layer` for a layer the user painted. `keep_color` writes the glow's own color instead of white.
   - **specular**: metal, wet or polished parts. Pass the metal ramp as `specular.colors` (with `value` for a flat shine, or let it follow lightness); without colors, the highlights get the shine. Keep `levels` low (3–4) for pixel art.
   Skip it for matte sprites. Tell the user which pixels were picked; they can paint fixes on the mask layers.
4. Check with `light_preview` from two or three sides (and a point light near an edge). Flat areas that should curve need a wider `bevel` or a painted height layer; inverted shading means the wrong convention. The preview uses the masks when they exist: glow stays lit on the dark side, shiny parts get a highlight.
5. Export with `export_normal_sheet` (<name>.png and <name>_n.png in the same layout, plus <name>_e.png and <name>_s.png when the masks exist) and tell the user how to assign it: in Godot, a CanvasTexture with the normal map on the Sprite2D; in Unity, a secondary texture `_NormalMap` on the sprite.
