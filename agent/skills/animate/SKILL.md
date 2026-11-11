---
name: animate
title: Animate a character or object
description: Make walk, run, idle, attack, jump and hit animations with proper keyframes, timing, arcs, squash and stretch and smears.
category: Animation
triggers: [animate, animation, walk cycle, run cycle, idle animation, attack animation, jump animation, smear]
intents: [animate, cycle]
tools: [walk_check, read_guide, apply_timeline_text, get_timeline_text, execute_lua, read_pixels, write_pixels, transform_layer, rotate_layer, squash_stretch, smear_frame, subpixel_move, spawn_agents, check, snapshot]
---
# Animate a character or object

## Plan first
1. Read the timing table before you plan: `read_guide("rules/animation")` (`rule:anim.timing` for frames, durations and key poses per animation; `rule:anim.budget` for how many frames the sprite's size can carry). Don't plan from memory.
2. Pick the animation's row, then write the frames and timing as timeline text (`apply_timeline_text`): add frames, a tag, and durations in one call. Use at least two durations (`rule:anim.ticks`).

## Block the key poses first (#99)
1. The first frame is the reference: keep it as it is. Its palette, height, facing and which parts are near and far stay the same in every frame; if the state block has a pixel spec, follow it.
2. Mark the landmarks on the reference before drawing: the ground row, the hip height, and for a walk the support foot. Every key keeps the hips at the table's height (`rule:anim.walk.limbs`, the Hip column), and a foot carrying weight stays on the ground row and slides back the same number of pixels each frame (the walk's ground speed, `rule:anim.timing.walk`), never forward or by a jump.
3. Draw only the key poses first, as flat silhouettes in one dark color on a layer `AI: Keys` (`aiLayer`): for a walk the two contacts and the two passing poses (contacts 1 and 4, passing 3 and 6 of 6: `rule:anim.walk.limbs`); for an attack or impact the anticipation, the hit and the hold. Look at them with `snapshot` `view: "filmstrip"` and fix proportions and arm and leg opposition now: flat shapes show limbs that cross or merge, which colors later hide.
4. Then draw the keys in color on the character's layers (split into parts when it helps: body, near arm, far arm, legs, weapon), over the silhouettes, using the sprite's palette. A walk needs arms that read: the near arm in front of the body (a darker step of the clothing, or skin for the hand), the far arm only past the body's edge. For a walk, put the near arm and the near leg on part layers named `near arm` and `near leg`, or tell `walk_check` their colors and rows.
5. **A walk isn't done until `walk_check` says ok.** Run it on the colored keys, before any in-between: at each contact it measures the near arm's hand against its shoulder and the near leg's foot against its hip, and the hand must be on the other side from the foot. On "errors", redraw the near arm on the frames it lists and run it again; on "unverifiable", fix what it names. Run it once more after the in-betweens, and report its verdict. Your own table of poses is not evidence: the check measures the pixels.
6. In-betweens last: each one from both keys beside it (`snapshot` `view: "onion"` on that frame shows them ghosted), halfway in position and shape; redraw only the parts that drift or overlap. For small sprites start from a copy of a key: `read_pixels` its rows, `write_pixels` them into the new frame, then change only what moves, so limbs keep their length. Rigid parts and props move with `transform_layer` (eased, along an arc, no new colors) or `rotate_layer`.
7. Delete `AI: Keys` when the frames are done. A held pose is one frame with a longer duration, never a repeated frame.
8. Many frames of drawing work: split them across sub-agents as `read_guide("parallel-frames")` says, with each frame's key or in-between described in the shared instruction.
9. `squash_stretch` for weight (jump take-off and landing; amounts in `rule:anim.squash`); `smear_frame` for fast swings and dashes; `subpixel_move` for moves smaller than a pixel per frame (breathing, bobbing, a slow drift, an eye sliding) in small sprites, so they shift shade instead of jumping.

## Check
1. `check` with rules `duplicate-frame` and `ground-jitter`: no frame should repeat the one before, and feet must stay on the same row while touching the ground. For an attack, also `check` with `expect: {must_not_overlap: [["Weapon", "Head"]]}` (your layer names).
2. `snapshot` with `view: "filmstrip"` and the `tag` before you report: every frame in one image, numbered. A GIF or a single snapshot shows you only one frame, so judge the motion here. Go through `rule:anim.review`: each frame moves on from the one before, the silhouette keeps its size and proportions, and the last frame leads back into the first. Fix what is off and look again.
3. For a walk or run, plan the limbs from `rule:anim.walk.limbs` (the near arm is forward exactly when the near leg is back), then `walk_check` measures them on the contacts. Fix every frame it lists until it says ok.
4. For a frame whose spacing or arc looks wrong, `snapshot` with `view: "onion"` and that `frame` (and the `tag`, so it wraps): the frame sits solid over its neighbors, the previous one ghosted red and the next blue. The frame should sit between them on a smooth path (`rule:anim.arcs`).
5. Reply with the frame list (what each frame is) and the timing.

Then: `review`, then `export-game` for a game.
