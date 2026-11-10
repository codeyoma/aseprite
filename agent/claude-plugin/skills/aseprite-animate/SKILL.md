---
name: aseprite-animate
title: Animate a character or object
description: Make walk, run, idle, attack, jump and hit animations with proper keyframes, timing, arcs, squash and stretch and smears.
category: Animation
triggers: [animate, animation, walk cycle, run cycle, idle animation, attack animation, jump animation, smear]
tools: [apply_timeline_text, get_timeline_text, execute_lua, transform_layer, rotate_layer, squash_stretch, smear_frame, subpixel_move, spawn_agents, check, snapshot]
---
# Animate a character or object

## Plan first
Pick the template, then write the frames and timing as timeline text (`apply_timeline_text`): add frames, a tag, and durations in one call.

| Animation | Frames | Timing | Keys |
|---|---|---|---|
| Idle (breathing) | 4 | 150–250 ms | 1 rest, 2 up 1 px (chest/head), 3 rest, 4 down 1 px; feet never move |
| Walk | 6 (or 8) | 100–120 ms | 1 contact (legs apart, body lowest), 2 down, 3 passing (legs crossed, body highest), 4 contact (other leg front), 5 down, 6 passing; arms swing opposite to legs |
| Run | 6 | 70–90 ms | like walk with a flight frame (both feet off the ground, body highest) instead of passing, more lean |
| Attack (melee) | 4–6 | anticipation 120–200 ms, strike 40–60 ms, follow-through 100 ms, recover 120 ms | wind-up away from the target, a smear on the strike frame, overshoot, return |
| Jump | 5–7 | crouch 80, launch 60, rise 100, apex 150, fall 100, land 80, recover 100 | squash before take-off, stretch on launch, squash on landing |
| Hit / hurt | 2–3 | 60–100 ms | snap back from the blow, white or red flash frame, recover |

## Draw
1. Split the character into parts on layers when it helps (body, near arm, far arm, weapon), so rigid parts can move with `transform_layer` (moves/rotates a part from one frame to another along an arc, eased, no new colors) or `rotate_layer`.
2. Draw keyframes (contacts, passing poses, the strike) with `execute_lua` using the sprite's palette, then fill in-betweens. Many frames of drawing work: hand them to `spawn_agents`, one or two frames each, with the template's description of each frame.
3. `squash_stretch` for weight (jump take-off and landing); `smear_frame` for fast swings and dashes; `subpixel_move` for moves smaller than a pixel per frame (breathing, bobbing, a slow drift, an eye sliding) in small sprites, so they shift shade instead of jumping.

## Check
1. `check` with rules `duplicate-frame` and `ground-jitter`: no frame should repeat the one before, and feet must stay on the same row while touching the ground.
2. `snapshot` a few frames side by side; keep the silhouette's size and proportions consistent across frames.
3. Reply with the frame list (what each frame is) and the timing.
