---
name: aseprite-make-directions
title: Make 4 or 8 directions
description: Complete a character's directions for top-down or isometric games: mirror what can be mirrored, draw the rest from the existing views, and lay them out as tags.
category: Directions
triggers: [8 directions, eight directions, 4 directions, four directions, all directions, isometric, top-down directions, facing]
intents: [this sprite, this character, my sprite, my character, drawing, draw]
tools: [read_guide, direction_plan, mirror_direction, spawn_agents, execute_lua, apply_timeline_text, transform_layer, iso_project, iso_grid, snapshot]
---
# Make 4 or 8 directions

1. Name the existing views as tags by direction if they aren't (e.g. `walk_S`, `walk_E`) with `apply_timeline_text`. Use the compass: S faces the viewer, E faces right.
2. `direction_plan` (count 4 or 8) lists what you have, what mirrors (E->W, NE->NW, SE->SW) and what to draw.
3. Mirror with `mirror_direction`. If the character holds something in one hand or has an asymmetric detail (a scar, a hair part), pass that layer in `keep_layers` and fix its position by hand, or tell the user.
4. Draw the remaining directions in new frames, one tag each, using the closest existing views as reference: the diagonals blend their neighbors (SE between S and E: the body turned three-quarters, the far side narrower), N shows the back. Keep the same height, proportions, palette and ground line (`rule:char.views`). For many frames, split them across sub-agents as `read_guide("parallel-frames")` says, with the reference frames described in the shared instruction.
5. Mirror the new diagonals you drew (draw SE, mirror to SW).
6. `snapshot` one frame of each direction side by side and check that they read as the same character turning; reply with the tag list.

Isometric: the 4 directions are the diagonals (`rule:iso.characters`). `iso_project` turns a top-down tile into a 2:1 diamond and `iso_grid` adds a guide layer; redraw the edges as clean 2:1 lines (`rule:iso.line`, `rule:iso.convert`).

Then: `animate` each direction, or `export-game`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "direction_plan", input: { ... } }). Their inputs:
- direction_plan {count?: 4|8}: Which of the 4 or 8 directions the sprite's tags cover (tags named like 'walk_E', 'SE', 'idle-north'), which missing ones can be made by mirroring (E<->W, NE…
- mirror_direction {tag: string, to?: string, new_tag?: string, keep_layers?: [string]}: Make a direction by mirroring another: copies a tag's frames to the end, flipped horizontally, as a new tag named for the new direction (walk_E -> walk_W).
- spawn_agents {instruction?: string, tasks: [object], parallel?: integer 1-4}: Split a multi-frame job into sub-tasks and run them in parallel, one sub-agent each (up to 4 at once).
- apply_timeline_text {text: string, plan?: boolean}: Change the timeline to match the text, in one undo step.
- transform_layer {layer: string, move: object, frames?: [integer], from_frame?: integer, to_frame?: integer, arc?: number, easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out"}: Move, turn, scale or squash a rigid part (a layer: an arm, a sword, a whole small sprite), RotSprite-style: pixels stay clean and no new colors appear.
- iso_project {layer?: string, frame?: integer}: Turn a top-down square tile or shape (a layer, active frame) into a 2:1 isometric diamond, pixel-exact, opened as a new sprite.
- iso_grid {tile?: integer 4-256}: Add a 2:1 isometric grid (tiles `tile` px wide) on an 'AI: iso grid' layer, as a drawing guide.
</skill-tools>
