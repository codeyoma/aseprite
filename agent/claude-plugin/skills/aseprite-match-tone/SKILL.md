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
