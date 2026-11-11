---
name: aseprite-model-to-sprites
title: 3D model to pixel sprites
description: Render a .glb, .gltf or .obj model into consistent pixel-art sprites in 4 or 8 directions, with its animations as frames.
category: 3D
triggers: [3d model, glb, gltf, obj, prerender, pre-rendered, 8 directions, model to sprite, blender]
intents: [3d, model, glb, gltf, obj, blender, render]
tools: [render_model, snapshot, check]
---
# 3D model to pixel sprites

- The user gives a model path. Start with `render_model` and `preview: true` at the target size to check the scale, the camera elevation and the colors. The preview shows one frame facing the viewer.
- Then render it: `directions` 8 for top-down or isometric characters, 4 for simple ones, 1 for props. Elevation: `three-quarter` for most top-down games, `isometric` (30°) for isometric games, `side` for platformers.
- Animations made from moving parts (glTF node transforms) become frames, with one tag per clip and direction, like `walk_S` or `walk_NE`. Pick a clip with `animation`, and set `fps` (8 to 12 suits pixel art). Skinned (bone) deformation is not applied: those models render in their rest pose, and the reply says so.
- Keep the defaults for pixel art: 3 toon bands, a darkest-color outline, and every frame at one shared scale on one ground line. Give `palette` ('sprite' or a name like 'PICO-8') to match a game's palette.
- After rendering, `snapshot` the result. Small renders lose detail, so suggest a hand clean-up pass: fix eyes and faces, and remove single stray pixels. `check` finds orphan pixels and jitter.

Then: `check-sprite` for the clean-up pass, then `export-game`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "render_model", input: { ... } }). Their inputs:
- render_model {path: string, size?: integer 8-256, directions?: 1|4|8|16, elevation?: "side"|"three-quarter"|"isometric"|"top-down"|number 0-90, bands?: integer 2-5, animation?: string, fps?: number 1-30, outline?: "none"|"darkest"|"selout", palette?: string, preview?: boolean, name?: string}: Render a 3D model (.glb, .gltf or .obj) into pixel-art sprites: an orthographic camera at an elevation ('side', 'three-quarter', 'isometric', 'top-down' or d…
</skill-tools>
