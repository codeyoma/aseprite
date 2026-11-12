# Animation timing {#anim}

When each drawing shows and how far things move between drawings. Durations are Aseprite frame durations in ms. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## Ticks and holds {#anim.ticks}

- Pick one base tick per animation and make every duration a multiple of it. 60 Hz games: 17, 33, 50, 67, 83, 100, 117, 133, 167 ms. Default: 100 ms.
- 40-50 ms only for a smear, a snap or the impact frame: seen, not read.
- A pose the player must read stays at least 80 ms; a weighted hold is 150-250 ms.
- Any loop of 4+ frames uses at least two durations: contacts and extremes longer, passing frames shorter.
- Nothing holds still longer than about 1 s: add a 1 px drift, a blink or a sway.

## Spacing and easing {#anim.spacing}

- Fix the beat first ("contact on frame 4"), then the offsets. Offsets add up to the travel.
- Ease in and out: small gaps at the keys, big in the middle. 12 px over 6 frames: 1 2 3 3 2 1. Fast start, soft stop: 4 3 2 2 1. Even spacing is for machines.
- Less than 1 px per frame is a hold or a shade shift (`subpixel_move`), never a jitter.
- In-betweens set the mood with the same two keys: 0-1 snap, 2-4 alert, 5-8 relaxed, 9+ heavy.
- To hit harder, cut the frame where the blow lands: show the fist past the target and the target already displaced 2-4 px.

## Frame budget by size {#anim.budget}

| Sprite | Idle | Walk | Run | Attack | Squash |
|---|---|---|---|---|---|
| 8 px | 2 | 2 | 2 | 2 | 0-1 px |
| 16 px | 2-4 | 4 | 4 | 3 + 1 recover | 1 px |
| 32 px | 4 | 6-8 | 6 | 4-6 | 2 px |
| 64 px | 4-8 | 8 | 8 | 6-8 | 2-4 px |

Under 16 px, longer holds beat extra drawings: 8 walk frames cannot be told apart at 16 px.

## Timing table {#anim.timing}

One line per animation: frames, durations, key poses. The sub-sections below give the details.

| Animation | Frames | Durations (ms) | Keys |
|---|---|---|---|
| Idle | 2-4 | 150-300 | rest, chest/head up 1 px, rest, down 1 px; feet never move |
| Walk | 6 (or 8) | 120 100 100 120 100 100 | contact, down, pass, contact, down, pass |
| Run | 6 | 80 70 80 80 70 80 | contact, down, flight, contact, down, flight |
| Attack | 4-6 | 120-200 / 40-60 / 80-120 / 100-120 | wind-up, strike (smear), hold, recover |
| Jump | 6-7 | 80 50 100 150 100 80 100 | crouch, launch, rise, apex, fall, land, recover |
| Hit | 2-3 | 60 / 50 / 100 | snap back, flash, recover |

### Idle {#anim.timing.idle}

- 2-4 frames, 150-300 ms each, durations not all equal (e.g. 300 150 300 150).
- Move the chest and head 1 px; the hair or cape follows a frame later. Feet and the ground row never move.
- Breathing is up on the in-breath, never sideways.

### Walk {#anim.timing.walk}

- A step is contact, down, pass (and up at 8 frames). Two steps make the cycle: frames 4-6 repeat 1-3 with the near and far limbs swapped, never flipped (flipping changes facing and light).
- Contact: legs widest, front heel down, back toe pushing, arms widest. Stride is about a third of the figure's height.
- Down (one frame after contact): knees bend, hip lowest. Pass: support leg straight, swing foot by the knee, hip highest.
- Hip bob: 1 px at 16 px, 2 px at 32, 3 px at 64. Arms swing opposite the legs: `rule:anim.walk.limbs` lists every frame.
- Contacts 20 ms longer than the rest: 6 frames at 120 100 100 120 100 100 (640 ms); 8 frames at 100-140 ms (0.8-1 s a cycle).
- The planted foot slides back at the speed the game moves the character: px moved per frame / frame time = px/s. Tell the user that speed.
- Shrinking: 8 -> 6 by dropping `up`, 6 -> 4 by dropping `down`. Keep the contacts.

### Walk limbs per frame, 6 frames facing right {#anim.walk.limbs}

Near = the side toward the viewer (drawn over the body); far = behind it. Forward = toward the facing direction. Hip is in px from the contact height (+ is lower).

| Frame | Pose | Near leg | Far leg | Near arm | Far arm | Hip |
|---|---|---|---|---|---|---|
| 1 | contact | forward, heel down | back, toe pushing | back | forward (shows past the chest) | 0 |
| 2 | down | forward, knee bent, foot flat | lifting off behind | back, less | forward, less | +1 |
| 3 | pass | straight under the hip | knee forward, foot off the ground | at the side | at the side | -1 |
| 4 | contact | back, toe pushing | forward, heel down | forward | back (hidden by the body) | 0 |
| 5 | down | lifting off behind | forward, knee bent, foot flat | forward, less | back, less | +1 |
| 6 | pass | knee forward, foot off the ground | straight under the hip | at the side | at the side | -1 |

The rule in one line: the near arm is forward exactly when the near leg is back.

### Run {#anim.timing.run}

- Like the walk, with flight frames (no foot on the ground, lowest foot 2+ px up) in place of pass: at least 1 of 6, 2 of 8.
- Contact lands under the body, not ahead; lean forward 1-2 px from hip to head; fists up, elbows bent.
- Hip bob is about twice the walk's. 6 frames at 70-90 ms (cycle 0.45-0.55 s): about half a walk cycle.

### Attack {#anim.timing.attack}

- Wind-up away from the target: 2-3 frames at 100-150 ms for enemies and bosses (the player's warning); for the player 0-1 frame of at most 50 ms, since more is input lag.
- Strike: one smear frame of 40-60 ms (`smear` mode sweep on that frame), weapon tip on an arc.
- Contact hold 80-120 ms (more with `hit_stop`, see `rule:vfx.hitstop`), overshoot 1-2 px, then 2-3 recovery frames at about 100 ms.
- Weight is in the recovery: a heavy swing recovers long, not winds up long.

### Jump {#anim.timing.jump}

- Crouch 80 (squash), launch 50-60 (stretch along the motion), rise 100, apex 120-150 (the only long hold), fall 100 (stretch), land 80 (squash), recover 100.
- Squash and stretch only on the takeoff and landing frames; see `rule:anim.squash`.

### Hit {#anim.timing.hit}

- Snap back from the blow in one frame (60 ms), a white or red flash frame (50-60 ms), recover over 1-2 frames (100 ms).
- The freeze and shake belong to the attacker's hit: `rule:vfx.hitstop`.

## Squash and stretch {#anim.squash}

- Keep the area: wider by N, lower by about N. An 8x8 ball squashes to 10x6 and stretches to 6x10.
- Amount by size: 1 px at 16, 2 px at 32, 2-4 px at 64.
- One squash drawing on contact; two make it rubber. Rigid things (a sword, a coin, a crate) never deform.

## Arcs and follow-through {#anim.arcs}

- Heads, hands and weapon tips move on arcs. Check a doubtful frame with `snapshot` `view: "onion"`: it should sit between its neighbors on a smooth curve.
- Followers (hair, cape, tail, weapon trail) lag the body by 1-2 frames and settle 3 -> 2 -> 1 -> 0 px.
- Limbs keep their length and width in every frame; start each frame from a copy of the last one (`read_pixels` then `write_pixels`).

## Loops {#anim.loops}

- The last frame leads into the first: play the filmstrip across the seam.
- No frame repeats the one before (`check` rule `duplicate-frame`); feet on the ground keep their row (`ground-jitter`).
- Parts can loop at different lengths (feet 6, hair 9) so the cycle does not feel mechanical.

## Mistakes {#anim.mistakes}

| You see | Cause | Fix |
|---|---|---|
| Slideshow: poses but no weight | Every frame the same duration | Hold contacts and extremes longer (`rule:anim.ticks`) |
| Floating walk | No `down` frame, or the hip never drops | Add `down`, bob 1-2 px (`rule:anim.timing.walk`) |
| Feet skate | Planted foot moves at a different speed from the character | Match px per frame to the game speed |
| Limbs grow or shrink | Each frame drawn from scratch | Copy the last frame's rows and change only what moves |
| Mush at 16 px | Too many in-betweens | Fewer drawings, longer holds (`rule:anim.budget`) |
| Laggy attack | Long player wind-up | 0-1 frame, at most 50 ms |
| Jelly | Squash on rigid parts, or on every frame | Contact frames only; rigid parts never deform |

## Review {#anim.review}

- [ ] Durations follow `rule:anim.timing` for the animation's kind, with at least two different durations.
- [ ] Keys read as silhouettes; adjacent frames differ, the loop closes.
- [ ] Feet on the ground keep their row; the planted foot moves at the character's speed.
- [ ] Volume is constant; squash only on contact frames.
- [ ] Heads, hands and tips follow arcs (onion view); followers lag 1-2 frames.

## Templates {#anim.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the sprite's own colors. Keys: `o` outline, `l` light, `m` mid, `d` dark.

### Ball at rest, 8x8 {#anim.tmpl.ball}

The reference mass for squash and stretch.

```grid
Legend: o=#2a1f33 l=#ffe0b0 m=#e07a3c d=#9a3a2a
. . o o o o . .
. o l l m m o .
o l l m m m m o
o l m m m m d o
o m m m m m d o
o m m m d d d o
. o d d d d o .
. . o o o o . .
```

### Ball squashed, 10x6 {#anim.tmpl.ball-squash}

The contact frame only: 2 px wider, 2 px lower.

```grid
Legend: o=#2a1f33 l=#ffe0b0 m=#e07a3c d=#9a3a2a
. . o o o o o o . .
. o l l m m m m o .
o l m m m m m m d o
o m m m m m m d d o
. o d d d d d d o .
. . o o o o o o . .
```

### Ball stretched, 6x10 {#anim.tmpl.ball-stretch}

The fast frames just before and after contact, stretched along the motion.

```grid
Legend: o=#2a1f33 l=#ffe0b0 m=#e07a3c d=#9a3a2a
. . o o . .
. o l m o .
o l l m m o
o l m m m o
o m m m m o
o m m m d o
o m m m d o
o m m d d o
. o d d o .
. . o o . .
```
