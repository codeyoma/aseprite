---
name: sprite-effects
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
