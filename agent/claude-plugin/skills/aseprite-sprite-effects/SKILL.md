---
name: aseprite-sprite-effects
title: Sprite effects: juice, smears, fluids, pipelines
description: Game feel made from a sprite's own pixels or simulated (squash and stretch, landing, wobble, bounce, shake, hit flash, spin, pop in/out, smear frames, afterimages, smoke, fire, gas, liquid, dissolve, outline glow) with the juice, smear, fluid_fx and fx_pipeline tools.
category: Effects
triggers: [juice, game feel, squash, stretch, squash and stretch, landing, wobble, jelly, bounce, shake, hit flash, flash white, pulse, spin, pop in, pop out, appear, disappear, smear, smear frame, motion blur, afterimage, trail, multiples, smoke, fire, flame, gas, steam, fluid, liquid, splash, dissolve, disintegrate, outline glow, aura, noise]
intents: [juice, smear, fluid, dissolve]
tools: [juice, smear, fluid_fx, fx_pipeline, fx_from_recipe, snapshot, check, check_fx, get_timeline_text]
---
# Sprite effects

These tools compute the effect in the bridge and write it in one undo step. Prefer them to drawing the frames by hand: they keep the art's palette, keep timing exact and leave the original layer hidden under a copy.

## Pick the tool
| The user asks for | Tool |
|---|---|
| A reaction of the art itself: squash on landing, stretch on a jump, jelly wobble, bounce, shake, hit flash, pulse, spin, lean, pop in, pop out | `juice` |
| Speed on a fast move: smear frames, afterimages, repeated copies along a swing | `smear` |
| Smoke, fire, gas, steam, a splash or a pour | `fluid_fx` |
| A look built from steps: dissolve, outline, glow, displacement, gradient map, noise, palette map, or several effects chained | `fx_pipeline` |
| A particle burst, a hit spark, an explosion or magic | the `pixel-fx` skill |

## Steps
1. Read the timeline (`get_timeline_text`): which layer holds the art, and on which frame the moment happens (the landing, the contact, the fastest frame).
2. Run the tool with `preview: true` (`apply: "preview"` for `fluid_fx` and `fx_pipeline`) and look at the contact sheet. Tune the strength (`amount`, `px`), the frame count and the spring (`cycles`, `damping`) until it reads at game size.
3. Apply it. `juice` and `smear` insert frames after the moment by default, or transform existing frames with `over`. Each writes `AI: <tool> <layer>` and hides the source; the rest of the sprite stays as it was.
4. Check: `snapshot` the result with `view: "filmstrip"`, then `check`. A fluid or pipeline effect on its own layer also takes `check_fx`.
5. Report the tool, the frames it wrote and the layer, in one or two sentences.

## Rules
- One effect per call; chain them in `fx_pipeline` when the user wants several on the same frames.
- Keep it short: juice reads best in 4-8 frames of 40-60 ms (`rule:anim.timing`).
- A frame that reaches the canvas edge is cut. Enlarge the canvas first, or lower `amount` or `px`.

Then: `review`, then `export-game` for a game.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "juice", input: { ... } }). Their inputs:
- juice {effect: "squash"|"stretch"|"wobble"|"bounce"|"shake"|"flash"|"pulse"|"spin"|"lean"|"pop_in"|"pop_out", layer?: string, frame?: integer, over?: string|integer|[integer], frames?: integer 1-48, duration_ms?: integer 10-2000, pivot?: "bottom"|"center"|"top"|object, amount?: number 0-2, px?: integer 1-256, cycles?: number 0.25-8, damping?: number 0-2, bounces?: integer 0-6, turns?: number -8-8, ease?: "linear"|"in_quad"|"out_quad"|"in_out_quad"|"in_cubic"|"out_cubic"|"in_out_cubic"|"in_back"|"out_back"|"in_out_back"|"out_elastic"|"out_bounce", color?: string, seed?: integer, preview?: boolean}: Make game-feel animation from a layer's own pixels, in one undo step: squash (lands flattened (wide and short, area kept) and springs back); stretch (shoots …
- smear {mode: "sweep"|"stretch"|"afterimage"|"multiples", layer?: string, tag?: string, loop?: boolean, frames?: string|integer|[integer], insert_after?: integer, vector?: object, min_px?: number 0-256, refine?: boolean, length?: number 0.1-2, taper?: number 0-1, thin?: boolean, fill?: "ramp"|"edge"|"source", amount?: number 0-2, copies?: integer 1-8, duration_ms?: integer 10-2000, preview?: boolean}: Make smears and motion trails from a layer's own motion, in one undo step.
- fluid_fx {preset: "smoke-puff"|"smoke"|"torch"|"fire-burst"|"poison-gas"|"steam"|"splash"|"pour", apply?: "preview"|"layer"|"sprite", width?: integer 8-128, height?: integer 8-128, frames?: integer 2-96, fps?: integer 4-30, duration_ms?: integer 100-8000, loop?: boolean, seed?: integer, colors?: "sprite"|[string], buoyancy?: number 0-200, vorticity?: number 0-60, wind?: number|object, dissipation?: number 0-10, gravity?: number 0-2000, strength?: number 0.1-5, level?: number 0-0.9, emitter?: object, emit_layer?: string, resolution?: 1|2, threshold?: number 0-0.9, x?: integer, y?: integer, start_frame?: integer}: Simulate a fluid and draw it as pixel art: gases on a small Stable Fluids grid (advection, pressure projection, vorticity confinement, buoyancy from temperat…
- fx_pipeline {pipeline: string|object, apply?: "preview"|"layer", replace?: boolean}: Make an effect from a JSON chain of steps over a layer's frames or a blank canvas, node-graph style: outlines, dissolves, displacement, gradient maps, glows,…
- fx_from_recipe {recipe: string|object, apply?: "preview"|"layer"|"sprite", x?: integer, y?: integer, anchor?: "center"|"ground", start_frame?: integer, glow?: "layer"|"baked"|"none"}: Make a game effect from a JSON recipe instead of picking one from the FX library: phases (charge, flash, burst, linger, decay) of particle emitters, lights, …
- check_fx {layer?: string, max_colors?: integer 1-256}: Check effect layers (one, or every layer with an FX record or named 'AI: fx …') for what eyes miss, with coordinates and a fix: spill (re-rendered from the l…
</skill-tools>
