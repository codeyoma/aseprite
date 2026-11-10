# Built-in skills for pixel-art and game development: research

Goal: a catalog of built-in skills in the chat panel, searchable from the input like pen.dev's skill list, where each skill is a capability the user can call by name ("Extract palette", "Fix AI pixel art", "Make 8 directions"). Skills build on tested tools, so results are reliable, not improvised Lua.

## What pen.dev does

Typing in pen.dev's chat lists skills by name, with a source label (`pen.dev` for built-ins, none for the user's own) and a one-line description: task skills such as "Make Website Responsive", "Add Stacked Animations", "Sitemap", and the user's design-engineering skills ("better-colors", "better-typography", "transitions-polish"). Built-in and user skills share one list and one search. Picking one starts a task with that skill's instructions.

What carries over:
- **One searchable list** of built-in and user skills, with the source and a description.
- **Task-shaped names**: a skill names a result ("Extract palette"), not an API.
- **Skills compose tools.** The skill is the procedure and the judgment; the heavy lifting is in tools.

## The landscape of pixel-art tools

| Area | Prior art | What users expect |
|---|---|---|
| AI and upscaled "fake" pixel art | [PerfectPixel](https://github.com/harjeb/perfectPixel), [unfake](https://pypi.org/project/unfake/), [Pixel Rehab](https://arcade.pirillo.com/pixel-rehab.html), [Pixel Grid Detector](https://spritecook.ai/pixel-grid-detector), Claude Code plugins pixel-snap and Pixel Snapper | Detect the grid (FFT, run-length GCD, edge autocorrelation), resample one color per cell, clean the palette, remove anti-aliasing |
| Palettes and ramps | Lospec Palette Importer, [Smart Palette](https://community.aseprite.org/t/extension-smart-palette/28320), [Rampart](https://sudo-whoami.itch.io/rampart), hue-shifted ramp scripts, [palette generator](https://ziva.sh/tools/pixel-art-palette-generator) | Extract colors from an image, reduce to N, group into ramps, hue-shift shadows cool and highlights warm |
| Generation and editing | [PixelLab](https://www.pixellab.ai/docs/options/details) (8-direction rotation, skeleton and text animation, tilesets, inpainting; also an MCP server) | Directions, animation from a pose, tiles, local fixes |
| Tilesets | [AutoBlob](https://community.aseprite.org/t/extension-autoblob-generate-the-full-47-tile-blob-autotile-set-from-6-template-tiles/28606), [Blobsmith](https://blobsmith.itch.io/blobsmith), [Blobator](https://github.com/Enichan/blobator), Tilesetter | #46 |
| 3D to pixel | [SpritePress](https://thespritewizard.itch.io/sprite-press), [Pixly Bakery](https://snappyworks.itch.io/pixlybakery), [True Pixel Art Generator](https://superhivemarket.com/products/true-pixel-art-generator-v2), Blender 8-direction render, [Pixelizing 3D objects](https://medium.com/@elliotbentine/pixelizing-3d-objects-b55ec33328f1) | Render a model in N directions with toon lighting, palette, outline, no anti-aliasing; voxel previews |
| Lighting | Aseprite Normal Maps Extension, Normal Toolkit, Normal Map Preview | Normal maps from height or by hand, preview with a light |

## Principles for our skills

1. **Deterministic core, agent judgment on top.** Grid detection, quantization, remapping, autotiling and rendering are algorithms: tools with tests. The agent picks parameters, checks results with `snapshot`/`check`/`diff_visual`, and iterates.
2. **Non-destructive.** Results go on `AI:` layers or new sprites (#25); every step is one undo step; variations where taste matters.
3. **Each skill is evaluated.** A fixture and an expected outcome per skill (batch test), so changes don't silently degrade it.
4. **References are the user's.** Skills that recreate or match a reference work from images the user attaches. Recreating another game's art is for study and personal use; the skill says so and doesn't fetch art from the web.

## Skill map

The catalog itself (searchable `/` picker, built-in skills, evals) is #35; tracking: #51.

| Skill | Category | Core tools | Issue |
|---|---|---|---|
| Extract palette | Color | `palette_from_image` | #36 |
| Fix AI / upscaled pixel art | Cleanup | `detect_pixel_grid`, `resample_to_grid`, `reduce_colors` | #37 |
| Match tone / unify palette | Color | `remap_to_palette`, `color_stats` | #38 |
| Ramps and auto-shading | Color, Drawing | `make_ramp`, `shade_flat`, outline variants | #39 |
| Recreate from reference | Import | `slice_sheet`, `detect_background`, `split_by_color` | #40 |
| Import sprite sheet | Import | `slice_sheet` | #41 |
| Animation helpers | Animation | inbetween, smear, squash/stretch, cycles | #42 |
| Directions | 2D/3D | mirror, 4/8-direction rotation, isometric | #43 |
| Tilesets | Tiles | `autotile`, seamless check | #46 |
| 3D model to sprites | 3D | headless renderer to N-direction sheets | #44 |
| Voxels | 3D | `.vox` import to isometric sprites | #45 |
| Normal maps and lighting | Lighting | `normal_from_height`, preview | #47 |
| Dithering | Color | ordered/pattern dithering in palette | #48 |
| Palette swaps | Color | index maps, LUT export | #48 |
| Engine export | Export | Godot/Unity/Phaser/Tiled presets | #49 |
| Pixel text and UI | UI | pixel fonts, 9-slice | #50 |
