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

Then: `export-game` for the color sheet and its animations.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "normal_map", input: { ... } }). Their inputs:
- normal_map {layer?: string, frames?: string|integer|[integer], source?: "bevel"|"luminance"|"height", height_layer?: string, bevel?: number 1-64, strength?: number 0.1-5, levels?: integer 0-8, convention?: "opengl"|"directx"}: Make a tangent-space normal map for a layer, for engines with 2D lights (Godot, Unity): height from a rounded bevel of the silhouette (default), from the col…
- make_masks {layer?: string, frames?: string|integer|[integer], kind?: "emission"|"specular"|"both", emission?: object, specular?: object}: Make grayscale material masks for a layer, beside its normal map, for engines with 2D lights.
- light_preview {layer?: string, normal_layer?: string, frame?: integer, light?: object, convention?: "opengl"|"directx", masks?: boolean}: Render a layer lit through its normal map ('AI: normal <layer>' by default) by a directional or point light, and return the image.
- export_normal_sheet {layer?: string, normal_layer?: string, frames?: string|integer|[integer], dir: string, name?: string}: Write <name>.png (the layer's frames side by side) and <name>_n.png (its normal map frames, same layout) for an engine's 2D lights, plus <name>_e.png / <name…
</skill-tools>
