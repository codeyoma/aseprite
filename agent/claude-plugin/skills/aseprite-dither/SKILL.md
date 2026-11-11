---
name: aseprite-dither
title: Dithering
description: Fill skies, backgrounds and large shapes with dithered gradients in the palette, or turn smooth shading into dithered palette steps.
category: Color
triggers: [dither, dithering, dithered, bayer, gradient sky, retro gradient]
tools: [dither_gradient, dither_to_palette, make_ramp, snapshot]
---
# Dithering

- **A gradient** (a sky, a glow, a background): pick 2–4 palette colors dark to light (`make_ramp` if the palette has no fitting ramp), then `dither_gradient` with the direction (vertical for skies, radial for glows) and area (the selection, a rectangle, or `mask_layer` to fill only a shape). Bayer 4x4 gives smooth steps; checker gives a harder, 1-bit look; Bayer 2x2 is coarser.
- **Smooth shading to pixel art** (a painted or imported layer): `dither_to_palette` with the sprite palette or a named one; lower `strength` to keep more flat areas.
- Keep dithering to large areas and transitions; small sprites usually read better with flat shading steps. `snapshot` at 1x and zoomed and check it doesn't turn noisy; reply with the colors and pattern.

Then: `check-sprite`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "dither_gradient", input: { ... } }). Their inputs:
- dither_gradient {colors: [string], direction?: "horizontal"|"vertical"|"radial"|"diagonal", pattern?: "bayer2"|"bayer4"|"checker", area?: "selection"|"canvas"|object, mask_layer?: string, frame?: integer}: Fill an area with an ordered-dithered gradient between palette colors (2 or more, e.g.
- dither_to_palette {layer?: string, frames?: string|integer|[integer], palette?: string, colors?: [string], pattern?: "bayer2"|"bayer4"|"checker", strength?: number 0-1}: Convert a layer with smooth shading or gradients (e.g.
- make_ramp {base: string, steps?: integer 2-9, hue_shift?: number 0-90, add_to_palette?: boolean}: A pixel-art color ramp through a base color, dark to light, with hue shifting (shadows turn cool toward blue/purple, highlights warm toward yellow) and softe…
</skill-tools>
