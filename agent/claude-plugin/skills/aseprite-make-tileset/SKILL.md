---
name: aseprite-make-tileset
title: Make a terrain tileset
description: Build a 47-tile blob or 16-tile autotile set for a terrain (grass, water, dirt…) from a 5- or 6-tile template, preview it on a tilemap layer, and export it for Godot or Tiled.
category: Tiles
triggers: [tileset, autotile, auto tile, terrain tiles, blob tileset, 47 tiles, wang tiles, seamless tile]
tools: [read_guide, make_autotile, seamless_check, make_seamless, execute_lua, snapshot]
---
# Make a terrain tileset

1. Settle the tile size (`rule:tile.size`: 16 by default, even) and the terrain (what's inside, what the edge looks like). Read `read_guide("rules/tiles")` for edges, variants and what makes a grid show.
2. If the user has no template, draw one on a new sprite, 5 tiles side by side at the top-left (width 5 × tile, height tile), in the sprite's palette:
   1. **island**: a lone patch: edge and outer corners on all four sides (round the corners);
   2. **vertical**: a piece of a vertical strip: edges on the left and right, open at the top and bottom;
   3. **horizontal**: a piece of a horizontal strip: edges on the top and bottom, open left and right;
   4. **fill**: the middle of the terrain, no edges; it must wrap seamlessly (`rule:tile.seamless`; `seamless_check` on it; `make_seamless` fixes a few clashing edge pixels, a wider seam needs redrawing);
   5. **inner**: the fill with an inner corner in each of the four corners (where the terrain turns around a notch).
   Keep the fill texture the same in all five so quarters join without seams.
   A 6-tile template in the RPG Maker layout also works (2 tiles wide, 3 high: a lone-tile preview and the inner corners on top, a 2x2 block of terrain with its border below); `make_autotile` tells them apart by shape. Use it when the user already has one.
3. Call `make_autotile` (`kind: 47` for full blob terrain, `16` for simpler side-only sets). It opens the set and a preview map on a tilemap layer whose tileset is the set, so the user can paint more terrain with it.
4. Look at the preview (`snapshot`) and go through `rule:tile.review`: seams in the middle mean the fill doesn't match between pieces; broken corners mean the island or inner tile's corners are off. Fix the template and run it again.
5. Export when asked: `export_dir` writes the PNG, a Godot 4 `.tres` (terrain set with peering bits), a Tiled `.tsx` (wang set) and a JSON bitmask map. Tell the user where they went and how to load them.
