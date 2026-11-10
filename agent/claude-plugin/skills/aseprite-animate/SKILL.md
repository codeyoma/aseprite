---
name: aseprite-animate
title: Animate a character or object
description: Make walk, run, idle, attack, jump and hit animations with proper keyframes, timing, arcs, squash and stretch and smears.
category: Animation
triggers: [animate, animation, walk cycle, run cycle, idle animation, attack animation, jump animation, smear]
tools: [read_guide, apply_timeline_text, get_timeline_text, execute_lua, read_pixels, write_pixels, transform_layer, rotate_layer, squash_stretch, smear_frame, subpixel_move, spawn_agents, check, snapshot]
---
# Animate a character or object

## Plan first
1. Read the timing table before you plan: `read_guide("rules/animation")` (`rule:anim.timing` for frames, durations and key poses per animation; `rule:anim.budget` for how many frames the sprite's size can carry). Don't plan from memory.
2. Pick the animation's row, then write the frames and timing as timeline text (`apply_timeline_text`): add frames, a tag, and durations in one call. Use at least two durations (`rule:anim.ticks`).

## Draw
1. Split the character into parts on layers when it helps (body, near arm, far arm, weapon), so rigid parts can move with `transform_layer` (moves/rotates a part from one frame to another along an arc, eased, no new colors) or `rotate_layer`.
2. Draw keyframes (contacts, passing poses, the strike) with `execute_lua` using the sprite's palette, then fill in-betweens. For small sprites, start each new frame from a copy of the last one: `read_pixels` the part's layer in frame N, `write_pixels` the same rows into frame N+1, then change only the keys that move, so limbs keep their length. Many frames of drawing work: hand them to `spawn_agents`, one or two frames each, with the template's description of each frame.
3. `squash_stretch` for weight (jump take-off and landing; amounts in `rule:anim.squash`); `smear_frame` for fast swings and dashes; `subpixel_move` for moves smaller than a pixel per frame (breathing, bobbing, a slow drift, an eye sliding) in small sprites, so they shift shade instead of jumping.

## Check
1. `check` with rules `duplicate-frame` and `ground-jitter`: no frame should repeat the one before, and feet must stay on the same row while touching the ground. For an attack, also `check` with `expect: {must_not_overlap: [["Weapon", "Head"]]}` (your layer names).
2. `snapshot` with `view: "filmstrip"` and the `tag` before you report: every frame in one image, numbered. A GIF or a single snapshot shows you only one frame, so judge the motion here. Go through `rule:anim.review`: each frame moves on from the one before, the silhouette keeps its size and proportions, and the last frame leads back into the first. Fix what is off and look again.
3. For a frame whose spacing or arc looks wrong, `snapshot` with `view: "onion"` and that `frame` (and the `tag`, so it wraps): the frame sits solid over its neighbors, the previous one ghosted red and the next blue. The frame should sit between them on a smooth path (`rule:anim.arcs`).
4. Reply with the frame list (what each frame is) and the timing.
