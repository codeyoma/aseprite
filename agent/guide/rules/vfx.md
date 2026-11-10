# Effects {#vfx}

Hits, slashes, explosions, magic, fire and smoke: phases, timing, color and shape. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## Phases {#vfx.phases}

- Every one-shot has three phases: flash (brightest, biggest jump in size), burst (the shape travels), dissipate (breaks up, darkens, shrinks).
- Rough time split 1 : 2 : 4. The flash is 1-2 frames; most of the effect's life is the fade.
- The impact frame is the brightest frame of the whole sequence and lines up with the attack's contact frame.

## Timing {#vfx.timing}

| Effect | Frames | Durations (ms) |
|---|---|---|
| Hit spark | 3-5 | 40-60 each |
| Slash smear | 3-4 | 30-50 each |
| Explosion | 8-12 | flash 1 x 40, fireball 3 x 60, smoke 4-6 x 80-100 |
| Smoke puff | 4-6 | 80-120 |
| Fire loop | 4-6 | 80-120 |
| Magic or status loop | 6-8 | 80-100 (0.5-1.5 s a cycle) |
| Snappy hit, spark, slash in all | | done in 0.3-0.8 s |
| Big explosion, nova, pillar in all | | lingers 2-4 s (smoke, embers) |

## Hit-stop and shake {#vfx.hitstop}

- Freeze both fighters on contact (`hit_stop` `freeze_ms`): 30-60 ms light, 80-120 ms solid, up to 200 ms for a finisher.
- Shake inside the freeze: 1-3 px, about half the freeze, decaying to 0.
- An optional white flash frame on the target, one frame only.

## Color ramps {#vfx.color}

- 3-5 colors from a bright core to a dark edge, with a hue shift: fire white, yellow, orange, red, brown; ice white, cyan, blue, navy; poison pale green, green, olive, purple.
- Pure white only in the flash and the core of the impact frame.
- An effect ages by stepping down its ramp each frame: bright pixels become the next darker color, edges go first.
- Glow belongs on its own Addition layer (`add_fx` `glow: "layer"`); the color layer stays opaque pixels.

## Shapes {#vfx.shape}

- Big clear shapes over many particles: a blob of dots is mush.
- Sparks are 1-2 px streaks along their direction; particles 1-3 px; no lone pixels except sparks.
- Flames taper upward and lick in 2-3 tongues; smoke is round clusters that grow, slow down and lose ramp steps.
- A smear or slash is a crescent, thick in the middle and tapered at both ends, along the weapon's arc.

## Scale to the character {#vfx.scale}

- Hit spark: a third to a half of the character's height. Slash: the weapon's reach. Explosion: 1-2 times the character.
- An effect drawn at another size is redrawn, not scaled (`rule:char.resize`).

## Loops {#vfx.loops}

- The last frame leads into the first: no ring, shape or particle pops at the seam (`check_fx` loop-seam).
- Frame durations add up to whole cycles.

## Mistakes {#vfx.mistakes}

| You see | Cause | Fix |
|---|---|---|
| Mush | Too many small particles, too bright | Fewer, larger shapes; darker ramp start |
| Speckle | Lone pixels everywhere | Shorter spark life, clusters (`rule:vfx.shape`) |
| Floaty | Long fade with no hit | Earlier impact, `hit_stop`, more drag (`rule:vfx.hitstop`) |
| Washed out | Glow over everything | Weaker light, glow on its own layer (`rule:vfx.color`) |
| Hit feels late | Impact frame not on contact | Line the brightest frame up with the contact (`rule:vfx.phases`) |
| Loop jumps | Shape missing at the seam | Match the last frame to the first (`rule:vfx.loops`) |

## Review {#vfx.review}

- [ ] Flash, burst and dissipate are all there, in about 1 : 2 : 4 time.
- [ ] The brightest frame is on the attack's contact frame; hit-stop fits `rule:vfx.hitstop`.
- [ ] 3-5 ramp colors with a hue shift; white only in the core.
- [ ] Size fits the character; no speckle.
- [ ] One-shots end empty; loops have no seam (`check_fx`).

## Templates {#vfx.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the effect's own ramp. Keys: `w` core white, `y` light, `o` mid, `r` dark.

### Hit spark, flash frame, 7x7 {#vfx.tmpl.spark-flash}

```grid
Legend: w=#ffffff y=#ffe066 o=#ff9a2e r=#c43c1e
. . . w . . .
. . . w . . .
. . y w y . .
w w w w w w w
. . y w y . .
. . . w . . .
. . . w . . .
```

### Hit spark, burst frame, 7x7 {#vfx.tmpl.spark-burst}

The shards have moved out and stepped down the ramp.

```grid
Legend: w=#ffffff y=#ffe066 o=#ff9a2e r=#c43c1e
. . . y . . .
. . . o . . .
. . . . . . .
y o . . . o y
. . . . . . .
. . . o . . .
. . . y . . .
```

### Slash crescent, 12x8 {#vfx.tmpl.slash}

One smear frame, swinging down on the right; thick in the middle, tapered at the ends.

```grid
Legend: w=#ffffff y=#ffe066 o=#ff9a2e r=#c43c1e
. . . . . . . . r w . .
. . . . . . . r y y w .
. . . . . . . . o y y w
. . . . . . . . . o y w
. . . . . . . . . o y w
. . . . . . . . o y y w
. . . . . . . r y y w .
. . . . . . . . r w . .
```
