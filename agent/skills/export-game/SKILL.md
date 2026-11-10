---
name: export-game
title: Export for a game engine
description: Export sprites as sheets with animations and import settings for Godot, Unity, Phaser/PixiJS or Tiled, with crisp pixels and no edge bleeding.
category: Export
triggers: [export for godot, export for unity, export for phaser, export to engine, spritesheet export, game export, atlas]
tools: [export_for_engine, get_timeline_text, apply_timeline_text, check]
---
# Export for a game engine

1. Ask which engine if the user didn't say (Godot, Unity, Phaser/PixiJS, Tiled, or plain JSON) and where to write.
2. Make sure the animations are tags with the right timing (`get_timeline_text`; fix with `apply_timeline_text`) — each tag becomes an animation. Hide guide layers (iso grid, references) so they aren't exported.
3. Run `check` and fix errors first (stray semi-transparent pixels show as dirty edges in engines).
4. Call `export_for_engine`. Defaults that suit most games: `trim: true`, `extrude: 1` (stops bleeding at frame edges when the camera moves or zooms), `pivot: "bottom-center"` for characters (`center` for items). Effects made with the FX tools: leave `pivot` out (the effect's origin is the pivot) and keep the default `glow: "sheet"` unless the user wants the glow baked in; `meta.fx` in the JSON carries fps, windup and hit-stops for the game. Unity: `pixels_per_unit` = the game's tile size.
5. Tell the user the files and the short import steps from HOW_TO_IMPORT.txt (e.g. Godot: Default Texture Filter = Nearest; Unity: copy the PNG and .meta together).

Then: `normal-map` when the game lights its sprites; otherwise the asset is done.
