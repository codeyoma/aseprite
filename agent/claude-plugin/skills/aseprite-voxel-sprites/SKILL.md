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
