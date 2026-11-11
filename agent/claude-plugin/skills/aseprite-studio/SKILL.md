---
name: aseprite-studio
title: From request to finished asset
description: Take a request that spans several steps (a new character, animated and exported for an engine) through a chain of skills, with a brief first, the chain written as your plan, each skill read when you reach it, a review and a closing compromise report.
category: Planning
triggers: [end to end, start to finish, from scratch to export, game-ready sprite, game ready sprite, full pipeline]
tools: [read_guide, list_skills, get_state, snapshot, check, critique, export_for_engine]
---
# From request to finished asset

Each skill does one job well. This one picks which skills a request needs, runs them in the order that keeps mistakes cheap, and owns the result until it is exported and reported. It never replaces them: at each step, read the skill and follow it, not your memory of it.

## Steps

1. **Read the room.** `get_state`: an open sprite changes the chain ("animate it" means the sprite that is there) and answers questions you would otherwise ask.
2. **Route.** Find the request's row in the table below; a big request joins several rows ("a knight with a walk cycle for Godot" is new art, then an animation, then an export). Leave out stages the request does not need, and add one only when the result would be unusable without it.
3. **Brief, when the request is open-ended.** Follow `brief`: your first message of the turn, as reply text the user reads (not your thinking), states the six decisions (size, palette, view, light, outline, destination). Ask only what truly blocks you; otherwise go on in the same turn. A specific request ("add a 1 px outline", "export this for Unity") needs no brief: do it.
4. **Write the chain as your plan.** End the brief message with the chain on one line, skill names in backticks: `Chain: `brief` → `animate` → `review` → `export-game``. Then put it in your plan or to-do tool if you have one (the Chat Panel shows it as a checklist): one item per stage, named after its skill, e.g. `brief`, `new sprite (recipes)`, `draw (pixel-art)`, `shade-sprite`, `animate`, `review`, `export-game`. Mark each item in progress when you start it and completed when its result has been looked at. This is the plan you report against.
5. **Run each stage.** When you reach it, `read_guide("<skill>")` and follow that skill, plus the `rule:` sections it cites for your subject (`read_guide("rules")` lists them). Hold every stage to the brief. Where a stage's skill says to ask the user (layer split, a choice of style), take its recommended answer, name it in one line, and go on: the brief was the one stop.
6. **Look after every stage that changed pixels.** `snapshot` (an animation: `view: "filmstrip"`). A stage is done when you have seen its result, not when its tool said it worked. `check` before the review.
7. **Review before export.** For sizable work run `review` (a fresh critic, at most three fix rounds). Small or simple results: `check` and a `snapshot` are enough; say which you did.
8. **Export last**, to the destination in the brief (`export-game` for an engine, into the folder the user named).
9. **Compromise report.** End with a short report: what exists now (sprite, layers, tags, frames, files written and where), each decision you made for the user, and a **Compromises** list: everything cut, approximated or changed from the brief, and why (fewer frames than the timing table asks for, a palette color added, a stage skipped, a critic finding left standing). "None" is a valid list only when it is true.

## Routing

| The user wants | Chain |
|---|---|
| A new character or prop, loosely described | `brief` → `concept` (the image generator, with the user's OK) → new sprite (`recipes`) → draw (`pixel-art`) → `shade-sprite` → `review` |
| A new animated character | the chain above → `animate` → `review` |
| A character from part layers, or a new motion for one (attack, guard, run...) | `character-motions` → `review` |
| Art for a game engine | the chains above → `export-game` |
| An animation of a sprite that exists | `animate` (`parallel-frames` to draw many frames at once) → `retime-animation` if the timing is off → `review` |
| More facing directions | `make-directions` → `animate` if each direction moves → `review` |
| Terrain or tiles | `brief` if open-ended → `make-tileset` → `review` |
| UI, buttons, text | `make-ui` → `export-game` |
| Effects (hits, magic, explosions) | `pixel-fx` → `export-game` |
| Game feel from the art itself or simulated: squash, wobble, shake, flash, smear frames, afterimages, smoke, fire, liquid, dissolve | `sprite-effects` → `review` |
| Colors, a fixed palette, a retro look | `extract-palette` or `match-tone` → `recolor` for variants, `dither` for gradients → `check-sprite` |
| Volume and light ("it looks flat") | `shade-sprite` → `normal-map` for dynamic lights → `review` |
| A picture the user supplied, as a sprite | `fix-pixel-art` (AI or upscaled art) or `recreate-from-reference` → `check-sprite` → `review` |
| A sprite sheet to animate | `import-sheet` → `retime-animation` → `export-game` |
| A 3D model or voxels to sprites | `model-to-sprites` or `voxel-sprites` → `check-sprite` → `export-game` |
| Options to choose from | `make-variations` → the chosen one continues its chain |
| Cleanup | `check-sprite` → `review` |
| An opinion ("is this good?") | `review` only; report, do not edit unless asked |

A request that fits no row is usually a single tool call ("rename the layer"): do it, `snapshot` if pixels changed, and say what you did. `list_skills` finds a skill the table does not name, including the user's own.

## Do not
- Skip the brief on an open-ended request to look fast: a wrong size or palette costs a full redraw.
- Ask again at every stage. One brief per request; a user who asked for a whole animation does not want to approve each frame.
- Downscale a reference onto the canvas and call it drawn: it guides shapes and poses; the pixels are still drawn.
- Report done without having looked, or leave scratch layers, a changed palette or a moved active frame that the user did not ask for without saying so.

Then: `studio` again for the next request on the same asset.

Adapted from aseprite-ai-artist's studio skill (MIT, https://github.com/with-pebbly/aseprite-ai-artist).

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "list_skills", input: { ... } }). Their inputs:
- list_skills {query?: string}: The skill catalog: built-in skills, guide topics and the user's own skills, with title, category and what each needs.
- critique {what?: string, frames?: string|integer|[integer], tag?: string, layer?: string, checkpoint?: string}: Have the sprite judged by a fresh critic agent that has not seen this conversation or the brief (read-only tools, the pixel-art rules).
- export_for_engine {engine: "godot"|"unity"|"phaser"|"tiled"|"json", dir: string, name?: string, trim?: boolean, padding?: integer 0-16, extrude?: integer 0-8, scale?: integer 1-8, power_of_two?: boolean, columns?: integer 1-64, pivot?: "bottom-center"|"center"|"top-left", glow?: "sheet"|"baked", pixels_per_unit?: integer 1-512}: Export the sprite's frames as a sheet with metadata for an engine: 'godot' (SpriteFrames .tres with an animation per tag), 'unity' (.png.meta with sliced spr…
</skill-tools>
