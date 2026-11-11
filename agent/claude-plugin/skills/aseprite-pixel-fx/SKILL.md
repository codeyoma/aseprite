---
name: aseprite-pixel-fx
title: Pixel FX
description: Add game effects (hits, slashes, explosions, magic, fire, smoke, status effects) from the FX library or a recipe, timed to an attack with hit-stop, checked and exported with a glow sheet.
category: Effects
triggers: [vfx, visual effect, particle effect, hit effect, explosion, slash effect, sword slash, spark, smoke effect, impact effect, hit stop, hitstop, hit-stop, magic effect, spell effect, status effect, frost nova]
tools: [read_guide, list_fx, preview_fx, fx_from_recipe, add_fx, fx_overlay, hit_stop, new_fx_sprite, propose_variations, execute_lua, snapshot, check_fx, check, export_for_engine]
---
# Pixel FX

## Pick before you make
1. `list_fx` with a few words from the request (`query: "slash"`, `category: "fire"`, `loop: true` for torches and auras). Each line gives the id, loop or one-shot, duration, size and default anchor.
2. `preview_fx` the one or two closest matches and look at the contact sheet before placing anything. Tune with `palette` (a dark-to-bright ramp in the game's colors, or `"sprite"` on `add_fx` to snap to the sprite palette), `seed` (another spark pattern), `options` (the effect's own sizes, from `list_fx`) and `light` (glow strength, 0-4).
3. Nothing fits (the library has no ice or frost, for example): write a recipe and `fx_from_recipe` it with `apply: "preview"` until it reads right, then `apply: "layer"`. A frost nova, as a starting point:
   ```json
   { "name": "frost-nova", "size": [96, 64], "origin": [48, 40], "duration": 0.7, "anchor": "ground", "floor": 4,
     "palette": ["#0e1a2e", "#1f4f8a", "#3f8fd0", "#9fdcff", "#ffffff"],
     "phases": [
       { "name": "flash", "start": 0, "end": 0.1, "shapes": [{ "type": "glow", "radius": 18, "alpha": [0.9, 0] }] },
       { "name": "burst", "start": 0, "end": 0.45, "bands": [{ "radius": [4, 40], "thickness": 3, "alpha": [1, 0] }],
         "emitters": [{ "kind": "flake", "count": 40, "speed": [60, 120], "spread": 180, "life": [0.3, 0.6], "drag": 2 }],
         "lights": [{ "radius": 30, "strength": 0.6, "life": 0.3 }] },
       { "name": "decay", "start": 0.15, "end": 0.5,
         "emitters": [{ "kind": "vapour", "count": 12, "speed": [5, 15], "life": [0.2, 0.35], "over": 0.1, "radius": 10, "y": -6 }] } ] }
   ```
   Keep every particle's delay + life inside `duration` so a one-shot ends empty. On an attack, give the recipe to `fx_overlay` (`recipe` instead of `id`, below) so it lands on the hit frame.

## Size it before you place it
Measure the character first (`snapshot` or its layer bounds), then set the recipe or options so that:
- **Reach** matches `rule:vfx.scale`. A nova or area burst spreads to 1.5-2 times the character's height; a ring that stays inside the staff's length reads as a spark.
- **Length** matches `rule:vfx.timing` at the sprite's own frame durations. Count the frames it will show on: at 100 ms frames, a 0.3 s effect is 3 frames (flash, one ring, gone). A burst needs at least 4-6 frames after the hit, so use `overflow: "extend"` when the tag ends sooner.
- **Weight** reads at 1x: the impact frame has a solid bright core, and rings are at least 2 px thick until they break up. A 1 px ring and scattered dots look faint from the first frame.
- **Ramp** reads as the element (`rule:vfx.color`). Most pixels sit on the bright and middle steps; the darkest step is only the rim of the fading parts. A ramp that starts at navy and fills the body reads as a dark blob.

## Variations
When the user wants options, offer 2-3 that differ in seed or palette. Quick: show `preview_fx` sheets and ask. In the sprite: `add_fx` each one (`glow: "baked"`), then in `execute_lua` move each `AI: fx` layer into the group `variationLayer(task, i)` makes (give it that layer's name, delete the empty one), set the frame to the impact and call `propose_variations(task)`. The user picks; don't pick for them.

## Apply
- **Onto the sprite:** `add_fx` puts the effect on `AI: fx <id>` layers (glow on an Addition layer above). Anchor `center` for hits, sparks, slashes and bolts (x, y is the impact point); `ground` for pillars, fires, circles and floor explosions (x, y is the floor under it).
- **On an attack:** `fx_overlay` with the attack's `tag`, `anchor_layer` (the character) or `x, y` (a staff tip, a fist), and `hit_frame` (the contact frame) lands the effect's impact on that frame. It takes a library `id` or your `recipe`. `overflow: "extend"` adds frames when the effect outlasts the tag (the character holds its last pose); the default `cut` chops the fade off. `flip: true` when the character faces left. Then `hit_stop` on the frame it reports, with the freeze it suggests or one from the table.
- **As its own sprite** (a reusable effect sheet): `new_fx_sprite`.

Timing: `rule:vfx.timing` for frame counts and durations, `rule:vfx.hitstop` for freeze and shake (`read_guide("rules/vfx")`).

## You see / fix
Shapes, ramps and scale: `rule:vfx.shape`, `rule:vfx.color`, `rule:vfx.scale`.

| You see | Fix |
|---|---|
| Mush: a blob with no shape | Fewer particles, a smaller `size` option or recipe size, a darker ramp start, `light` down |
| Speckle: lone pixels everywhere | Fewer, larger particles; a shorter life for sparks; snap with `palette: "sprite"` |
| Floaty: no weight, drifts forever | Shorter duration, more drag or gravity, the impact earlier (`hit_frame`), add a `hit_stop` |
| Washed out: the glow eats the art | `light` 0.5-0.8, a darker palette, or `glow: "layer"` and lower that layer's opacity |
| Tiny: a spark where a burst was asked | Recipe radius and ring reach up to `rule:vfx.scale`; more frames after the hit |
| Lingering: particles left on the last frame | Shorter particle life, or `overflow: "extend"` so the fade finishes; the tag's last frame holds no effect pixels |
| Loop seam: a jump when it wraps | Recipe: rings and shapes gone or matching at the end; sprite: frame timings that fit whole cycles (`check_fx` loop-seam) |

## Finish
1. `snapshot` with `view: "filmstrip"` over the attack: the effect grows on the hit frame, travels for several frames and is gone on the last one.
2. `check_fx` (spill, one-shot-end, loop-seam, colors) and fix what it reports; then `check` for the sprite as a whole (glow layers are skipped there).
3. When the user wants it in a game: `export_for_engine` with `pivot` left out (the effect's origin is the pivot) and `glow: "sheet"`, so the light ships as `<name>_glow.png` for additive drawing; `meta.fx` carries fps, windup and hit-stops.
4. Reply with the effect (id or recipe), where and on which frames it sits, the hit frame and freeze, and what the checks said.

Then: `export-game`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "list_fx", input: { ... } }). Their inputs:
- list_fx {query?: string, category?: string, loop?: boolean}: List the Pixel FX library: game effects rendered as pixel art (impacts, melee slashes, explosions, lightning, arcane, holy, fire, poison).
- preview_fx {id: string, options?: object, palette?: [string], frames?: integer 1-64, zoom?: integer 1-8, fps?: number 1-60, seed?: integer}: Render an effect from the FX library as a contact sheet PNG: its frames in a grid, numbered, on a dark backdrop with the glow baked in, cut to where the effe…
- fx_from_recipe {recipe: string|object, apply?: "preview"|"layer"|"sprite", x?: integer, y?: integer, anchor?: "center"|"ground", start_frame?: integer, glow?: "layer"|"baked"|"none"}: Make a game effect from a JSON recipe instead of picking one from the FX library: phases (charge, flash, burst, linger, decay) of particle emitters, lights, …
- add_fx {id: string, x?: integer, y?: integer, anchor?: "center"|"ground", slice?: string, start_frame?: integer, flip?: boolean, angle?: number, seed?: integer, palette?: "sprite"|[string], light?: number 0-4, glow?: "layer"|"baked"|"none", fps?: number 1-60, options?: object}: Add an effect from the FX library to the active sprite, in one undo step.
- fx_overlay {id?: string, recipe?: string|object, x?: integer, y?: integer, anchor_layer?: string, anchor?: "center"|"ground", tag?: string, start_frame?: integer, flip?: boolean, timing?: "resample"|"retime", hit_frame?: integer, overflow?: "extend"|"cut", seed?: integer, palette?: "sprite"|[string], light?: number 0-4, glow?: "layer"|"baked"|"none", fps?: number 1-60, options?: object}: Put an effect from the FX library (id) or a recipe (as fx_from_recipe takes) onto a character's animation (a tag, or the frames from start_frame), in one und…
- hit_stop {frame?: integer, freeze_ms: integer 1-5000, shake?: object, flash_layer?: string}: Freeze an animation on its contact frame, in one undo step: the contact pose holds freeze_ms longer in all, so the animation grows by exactly freeze_ms.
- new_fx_sprite {id: string, options?: object, fps?: number 1-60, seed?: integer, palette?: [string], light?: number 0-4}: Make an effect from the FX library its own sprite: its canvas, every frame at fps (frame durations 1000/fps ms), glow baked in, a tag named after the effect,…
- check_fx {layer?: string, max_colors?: integer 1-256}: Check effect layers (one, or every layer with an FX record or named 'AI: fx …') for what eyes miss, with coordinates and a fix: spill (re-rendered from the l…
- export_for_engine {engine: "godot"|"unity"|"phaser"|"tiled"|"json", dir: string, name?: string, trim?: boolean, padding?: integer 0-16, extrude?: integer 0-8, scale?: integer 1-8, power_of_two?: boolean, columns?: integer 1-64, pivot?: "bottom-center"|"center"|"top-left", glow?: "sheet"|"baked", pixels_per_unit?: integer 1-512}: Export the sprite's frames as a sheet with metadata for an engine: 'godot' (SpriteFrames .tres with an animation per tag), 'unity' (.png.meta with sliced spr…
</skill-tools>
