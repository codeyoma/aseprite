---
name: aseprite-animate
title: Animate a character or object
description: Make walk, run, idle, attack, jump and hit animations with proper keyframes, timing, arcs, squash and stretch and smears.
category: Animation
triggers: [animate, animation, walk cycle, run cycle, idle animation, attack animation, jump animation, smear]
intents: [animate, cycle]
tools: [generate_character, motion_stage, walk_check, motion_review, read_guide, apply_timeline_text, get_timeline_text, execute_lua, read_pixels, write_pixels, transform_layer, rotate_layer, squash_stretch, smear_frame, subpixel_move, spawn_agents, check, snapshot]
---
# Animate a character or object

## Plan first
1. Read the timing table before you plan: `read_guide("rules/animation")` (`rule:anim.timing` for frames, durations and key poses per animation; `rule:anim.budget` for how many frames the sprite's size can carry). Don't plan from memory.
2. Pick the animation's row, then write the frames and timing as timeline text (`apply_timeline_text`): add frames, a tag, and durations in one call. Use at least two durations (`rule:anim.ticks`).

A character built from part layers (a group `AI: <name>`), or a new motion for one: follow `read_guide("character-motions")`, which appends the motion after the base pose and generates it per layer.

## Block the key poses first (#99)
1. The first frame is the reference: keep it as it is. Its palette, height, facing and which parts are near and far stay the same in every frame; if the state block has a pixel spec, follow it.
2. Mark the landmarks on the reference before drawing: the ground row, the hip height, and for a walk the support foot. Every key keeps the hips at the table's height (`rule:anim.walk.limbs`, the Hip column), and a foot carrying weight stays on the ground row and slides back the same number of pixels each frame (the walk's ground speed, `rule:anim.timing.walk`), never forward or by a jump.
3. Start the stage: `motion_stage` `action: "keys"` with the tag (a 6-frame walk's keys are 1, 3, 4, 6). Until it advances, an edit that changes another frame of the tag is undone, so the in-betweens wait for checked keys. Get the keys from the image generator: `generate_character` with the key poses (one line each), `frames` the keys, `tag`, and a subject that describes the character; the sprite's frame 1 goes along as the reference, so the design stays. Its part layers (near and far arm and leg, torso, head...) land on the key frames; clean them so the joints meet. If the user declines it, draw only the key poses yourself, as flat silhouettes in one dark color on a layer `AI: Keys` (`aiLayer`): for a walk the two contacts and the two passing poses (contacts 1 and 4, passing 3 and 6 of 6: `rule:anim.walk.limbs`); for an attack or impact the anticipation, the hit and the hold. Look at them with `snapshot` `view: "filmstrip"` and fix proportions and arm and leg opposition now: flat shapes show limbs that cross or merge, which colors later hide.
4. Then draw the keys in color on the character's layers (split into parts when it helps: body, near arm, far arm, legs, weapon), over the silhouettes, using the sprite's palette. A walk needs arms that read, and players pair an arm with the leg that shares its depth cue: give the near arm and the near leg the same cue (both the lighter step, drawn over the body and the far leg) and the far arm and far leg both the darker step, the far arm only past the body's edge. A near arm darker than the shirt next to a light near leg reads as the dark far leg's arm. `walk_check` measures it: the near leg must be at least 0.12 lighter (OKLab L) than the far leg, e.g. a mid grey-violet near leg against a navy far leg, not two dark trouser shades. For a walk, put the near arm and the near leg on part layers named `near arm` and `near leg`, or tell `walk_check` their colors and rows.
5. **A walk isn't done until `walk_check` says ok.** Run it on the colored keys, before any in-between: at each contact it measures the near arm's hand against its shoulder and the near leg's foot against its hip, and the hand must be on the other side from the foot. On "errors", redraw the near arm on the frames it lists and run it again; on "unverifiable", fix what it names. When it says ok, `motion_stage` `action: "advance"` (it runs the same check) opens the in-betweens. Run it once more after the in-betweens, and report its verdict. Your own table of poses is not evidence: the check measures the pixels. Then `motion_review`: a fresh critic says which leg and arm read as near on the contacts; fix what it lists (usually the near limbs' contrast against the far ones), then run both again. Report both verdicts.
6. In-betweens last, per part layer: move and rotate each part halfway between the keys beside it (`transform_layer`, `rotate_layer` on that layer), so limbs keep their length; then clean the joints. Without part layers, draw each one from both keys beside it (`snapshot` `view: "onion"` on that frame shows them ghosted), halfway in position and shape; redraw only the parts that drift or overlap. For small sprites start from a copy of a key: `read_pixels` its rows, `write_pixels` them into the new frame, then change only what moves, so limbs keep their length. Rigid parts and props move with `transform_layer` (eased, along an arc, no new colors) or `rotate_layer`.
7. Delete `AI: Keys` when the frames are done, then `motion_stage` `action: "done"`. A held pose is one frame with a longer duration, never a repeated frame.
8. Many frames of drawing work: split them across sub-agents as `read_guide("parallel-frames")` says, with each frame's key or in-between described in the shared instruction.
9. `squash_stretch` for weight (jump take-off and landing; amounts in `rule:anim.squash`); `smear_frame` for fast swings and dashes; `subpixel_move` for moves smaller than a pixel per frame (breathing, bobbing, a slow drift, an eye sliding) in small sprites, so they shift shade instead of jumping.

## Check
1. `check` with rules `duplicate-frame` and `ground-jitter`: no frame should repeat the one before, and feet must stay on the same row while touching the ground. For an attack, also `check` with `expect: {must_not_overlap: [["Weapon", "Head"]]}` (your layer names).
2. `snapshot` with `view: "filmstrip"` and the `tag` before you report: every frame in one image, numbered. A GIF or a single snapshot shows you only one frame, so judge the motion here. Go through `rule:anim.review`: each frame moves on from the one before, the silhouette keeps its size and proportions, and the last frame leads back into the first. Fix what is off and look again.
3. For a walk or run, plan the limbs from `rule:anim.walk.limbs` (the near arm is forward exactly when the near leg is back), then `walk_check` measures them on the contacts. Fix every frame it lists until it says ok.
4. For a frame whose spacing or arc looks wrong, `snapshot` with `view: "onion"` and that `frame` (and the `tag`, so it wraps): the frame sits solid over its neighbors, the previous one ghosted red and the next blue. The frame should sit between them on a smooth path (`rule:anim.arcs`).
5. Reply with the frame list (what each frame is) and the timing.

Then: `review`, then `export-game` for a game.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "generate_character", input: { ... } }). Their inputs:
- generate_character {subject?: string, view?: string, poses?: [string], frames?: [integer], tag?: string, target_size?: [integer 1-512, integer 1-512]|object, layers?: [object], colors?: integer 4-64, name?: string, reference?: boolean, base_frame?: integer, inbetweens?: boolean, job?: string}: A new character as body-part layers from the image generator (#103): first a master sheet with the whole character in every key pose, then one image per laye…
- motion_stage {action?: "keys"|"advance"|"done", tag?: string, keys?: [integer], walk?: boolean}: Draw an animation in stages (#99).
- walk_check {tag?: string, facing?: "right"|"left", contacts?: [integer, integer], near_arm?: object, near_leg?: object}: Check a side-view walk's arms against its legs on the two contact frames: the near arm must swing opposite the near leg, and each must change sides between t…
- motion_review {tag?: string}: A fresh critic looks at a walk's two contact frames (enlarged, no measurements, no brief) and says which arm it notices, which leg it pairs with that arm, an…
- apply_timeline_text {text: string, plan?: boolean}: Change the timeline to match the text, in one undo step.
- get_timeline_text {}: The active sprite's timeline as compact text: frame count, frame durations, tags (range, direction, repeats) and linked cels.
- transform_layer {layer: string, from_frame: integer, to_frame: integer, move: object, arc?: number, easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out"}: Animate a rigid part (a layer: an arm, a sword, a whole small sprite) from its drawing in from_frame through to_frame: each frame gets the drawing moved/rota…
- rotate_layer {layer: string, frames: [integer], angle: number, pivot_x?: number, pivot_y?: number}: Rotate a layer's drawing in some frames by an angle around a pivot, RotSprite-style (clean edges, no new colors).
- squash_stretch {layer: string, frame: integer, amount: number -0.6-0.6}: Squash (amount < 0, e.g.
- smear_frame {layer: string, frame: integer, from_frame: integer, to_frame: integer, steps?: integer 2-16}: Turn a frame into a smear: the layer's drawing at to_frame swept back along the path from from_frame, so a fast move (a swing, a dash) reads in one frame.
- subpixel_move {layer: string, from_frame: integer, to_frame: integer, dx?: number -4-4, dy?: number -4-4, easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out"}: Move a layer's drawing by less than a pixel per frame without it jumping: each frame from from_frame+1 to to_frame shifts it a fraction further toward (dx, d…
- spawn_agents {instruction?: string, tasks: [object], parallel?: integer 1-4}: Split a multi-frame job into sub-tasks and run them in parallel, one sub-agent each (up to 4 at once).
</skill-tools>
