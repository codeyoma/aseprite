---
name: aseprite-make-tileset
title: Make a terrain tileset
description: Build a 47-tile blob or 16-tile autotile set for a terrain (grass, water, dirt…) from five template tiles, preview it on a map, and export it for Godot or Tiled.
category: Tiles
triggers: [tileset, autotile, auto tile, terrain tiles, blob tileset, 47 tiles, wang tiles, seamless tile]
tools: [make_autotile, seamless_check, execute_lua, snapshot]
---
# Make a terrain tileset

1. Settle the tile size (16 by default; it must be even) and the terrain (what's inside, what the edge looks like).
2. If the user has no template, draw one on a new sprite, 5 tiles side by side at the top-left (width 5 × tile, height tile), in the sprite's palette:
   1. **island**: a lone patch: edge and outer corners on all four sides (round the corners);
   2. **vertical**: a piece of a vertical strip: edges on the left and right, open at the top and bottom;
   3. **horizontal**: a piece of a horizontal strip: edges on the top and bottom, open left and right;
   4. **fill**: the middle of the terrain, no edges; it must wrap seamlessly (`seamless_check` on it);
   5. **inner**: the fill with an inner corner in each of the four corners (where the terrain turns around a notch).
   Keep the fill texture the same in all five so quarters join without seams.
3. Call `make_autotile` (`kind: 47` for full blob terrain, `16` for simpler side-only sets). It opens the set and a preview map.
4. Look at the preview (`snapshot`): seams in the middle mean the fill doesn't match between pieces; broken corners mean the island or inner tile's corners are off. Fix the template and run it again.
5. Export when asked: `export_dir` writes the PNG, a Godot 4 `.tres` (terrain set with peering bits), a Tiled `.tsx` (wang set) and a JSON bitmask map. Tell the user where they went and how to load them.
