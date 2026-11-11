---
name: aseprite-voxel-sprites
title: Voxels to isometric sprites
description: Turn MagicaVoxel models or stacked layers into consistent isometric pixel-art sprites in 4 directions.
category: 3D
triggers: [voxel, voxels, magicavoxel, .vox, isometric object, 2.5d]
tools: [render_voxels, layers_to_voxels, snapshot]
---
# Voxels to isometric sprites

- **A .vox model** (the user gives the path): `render_voxels` with 4 directions (or 1). Each direction is a frame tagged SE, SW, NW, NE, all the same size and standing on the same line, with the model's colors as the palette.
- **From layers**: draw an object top-down as slices on layers, bottom layer = the ground slice, one layer per voxel of height (keep slices the same size); `layers_to_voxels` stacks and renders them, and `save_vox` writes a .vox to keep editing in MagicaVoxel.
- Each voxel becomes a 4x4 block with three shades (lit top, mid left, dark right). For bigger sprites, scale the model in MagicaVoxel rather than the sprite.
- `snapshot` the directions side by side and reply with the size and tags. Fine details (windows, faces) can be painted on afterwards on a layer above.

Then: `export-game`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "render_voxels", input: { ... } }). Their inputs:
- render_voxels {path: string, directions?: 1|4, name?: string}: Render a MagicaVoxel .vox model as pixel-exact isometric sprites (2:1, each voxel a 4x4 block, three shades per material: lit top, mid left, dark right), in …
- layers_to_voxels {frame?: integer, directions?: 1|4, save_vox?: string, name?: string}: Build a voxel object from the sprite's layers, bottom layer = the ground slice, each layer one voxel higher (top-down drawings: image x is width, image y is …
</skill-tools>
