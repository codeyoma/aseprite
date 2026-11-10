---
name: aseprite-normal-map
title: Normal maps and lighting
description: Make normal maps so sprites react to 2D lights in Godot or Unity, preview them under lights, and export color and normal sheets.
category: Lighting
triggers: [normal map, normalmap, normals, 2d lighting, dynamic lighting, lit sprite]
tools: [normal_map, light_preview, export_normal_sheet, snapshot]
---
# Normal maps and lighting

1. Pick the height source:
   - **bevel** (default): rounded edges from the silhouette; good for round objects, characters and props.
   - **luminance**: the sprite's own shading becomes height; good when the art is already shaded from the front.
   - **height**: the user (or you) paints a grayscale height layer (white = high); best control.
2. Call `normal_map` on the layer (all frames). It goes on a hidden 'AI: normal <layer>' layer; `levels` 2–3 keeps the pixel look, 0 is smooth. Ask which engine: Godot and Unity use OpenGL (the default); DirectX engines need `convention: "directx"`.
3. Check with `light_preview` from two or three sides (and a point light near an edge). Flat areas that should curve need a wider `bevel` or a painted height layer; inverted shading means the wrong convention.
4. Export with `export_normal_sheet` (<name>.png and <name>_n.png in the same layout) and tell the user how to assign it: in Godot, a CanvasTexture with the normal map on the Sprite2D; in Unity, a secondary texture `_NormalMap` on the sprite.
