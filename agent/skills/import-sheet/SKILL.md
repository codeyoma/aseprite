---
name: import-sheet
title: Import a sprite sheet
description: Turn a sprite sheet image, or an animated file (GIF, WebP, .aseprite) as it is, into an animated sprite with frames and tags, from a grid, loose sprites on a background, or an atlas (Aseprite or TexturePacker JSON, TexturePacker XML, Godot SpriteFrames .tres).
category: Import
triggers: [sprite sheet, spritesheet, import sheet, slice sheet, atlas, gif, animated gif, webp animation, import animation]
intents: [import, slice, load, open this, from this sheet, from this gif]
needs: [image]
tools: [import_sheet, import_animation, snapshot, apply_timeline_text]
---
# Import a sprite sheet

0. An animated file (GIF, WebP, APNG, .aseprite) already has its frames: use `import_animation` with its path. Into a new sprite by default; `into: "layer"` (and `frame`) when the user wants it in the open sprite. The file's timing is kept. Then check with `snapshot` and reply.
1. Take the attached sheet (its path is in the `[Attached image …, file <path>]` line). If the user mentions an atlas (.json, .xml or .tres), pass its path as `atlas`; one with the same name next to the image is found on its own.
2. Pick the mode from what you see or what the user says:
   - poses in a regular grid → `mode: "grid"` (let it find the cell size from the gutters, or pass `cell_w`/`cell_h`, `padding_x/y`, `margin_x/y` if the user gives them);
   - loose sprites on a background, different sizes → `mode: "auto"` (raise `merge_distance` if parts of one sprite come apart, lower it if neighbors merge);
   - an atlas next to the image (.json, .xml, .tres) → `mode: "atlas"`.
3. Name tags from the user's words ("row 1 is idle, row 2 is walk" → `row_tags: ["idle", "walk"]`).
4. Check the result: the frame count and size in the reply, and `snapshot` of a frame or two. If frames are cut wrong, adjust and import again (the import opens a new sprite each time).
5. Set timing if the user gave it (`apply_timeline_text`), and reply with frames, size and tags.

Then: `retime-animation`, then `export-game`.
