---
name: aseprite-match-tone
title: Match tone and palette
description: Make a sprite or layer match another's colors and mood (lightness, saturation, contrast, warmth), or limit it to a palette such as PICO-8.
category: Color
triggers: [match tone, match colors, same palette, unify colors, too saturated, color grade, recolor to]
tools: [color_stats, adjust_tone, remap_to_palette, palette_from_image]
---
# Match tone and palette

1. Identify what should change (a layer, or the sprite) and the reference: another layer, an attached image (`source: "file"`), or a named palette.
2. Call `color_stats` with `compare_to` the reference. Tell the user the differences in plain words ("yours is darker and 30% more saturated, with warmer shadows").
   `color_stats` also gives the hue mix, the outline color (or selout) and the ramps with their step counts: match those too when they differ (e.g. a 3-step ramp next to a 5-step one, a black outline next to a dark-hued one).
3. Choose the fix:
   - Mood only (keep its own colors): `adjust_tone` with `match_to` the reference at full strength (the default). Use `strength` 0.5–0.8 only when the user asks for a subtler change, or for a second variation.
   - Same palette: `remap_to_palette` with the reference's colors (`palette_from_image` on the reference, then `colors`), or a named palette (`palette: "PICO-8"`). Ramps keep their order.
   - Both: adjust the tone first, then remap.
4. When taste matters, make two versions as variations (duplicate the layer with `variationLayer`, apply different strengths, `propose_variations`).
5. Run `color_stats` again with `compare_to`. If it still reports a clear difference (e.g. more than 30% in saturation), apply `adjust_tone` once more. Report what's left of the difference and `snapshot` the result.

Then: `check-sprite`.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "color_stats", input: { ... } }). Their inputs:
- color_stats {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, compare_to?: object}: Tone statistics of a source (mean lightness, saturation, contrast, warmth, color count, darkest/lightest), its hue histogram, its outline color (the color ar…
- adjust_tone {layer?: string, frames?: string|integer|[integer], lightness?: number -1-1, saturation?: number -1-3, contrast?: number -1-3, hue?: number -180-180, match_to?: object, strength?: number 0-1, snap_to_palette?: boolean}: Shift a layer's or the sprite's tone in OKLCH: lightness (-1..1, small values like 0.05), saturation and contrast (relative, e.g.
- remap_to_palette {palette?: string, colors?: [string], file?: string, layer?: string, frames?: string|integer|[integer], preserve_ramps?: boolean, set_palette?: boolean}: Recolor a layer or the sprite so it uses only a palette's colors, by perceptual distance (OKLab).
- palette_from_image {source?: "sprite"|"layer"|"selection"|"file", path?: string, layer?: string, frames?: string|integer|[integer], frame?: integer, max_colors?: integer 2-256, method?: "exact"|"median-cut"|"k-means", set_palette?: boolean, swatches?: boolean, save?: string, save_gpl?: string, ignore_alpha_below?: integer 1-255, min_share?: number 0-0.5, compare_with?: [string]}: The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to light), near-duplicate colors, and the closest…
</skill-tools>
