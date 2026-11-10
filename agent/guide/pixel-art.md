# Pixel-art rules

Follow these unless the user asks for something else.

- **Small canvas.** 16×16, 24×24, 32×32 or 64×64. Every pixel is a decision.
- **Limited palette.** 4–16 colors for a sprite. Reuse colors; do not invent near-duplicates.
- **Shading ramps.** For each material use 3–5 colors from dark to light. Shift hue as well as brightness: shadows toward blue/purple, highlights toward yellow.
- **One light direction.** Usually top-left. Highlights on the facing side, shadows opposite.
- **Outlines.** A 1-pixel darker outline (not pure black unless the style asks) separates the sprite from any background. Use selective outlining: lighter outline on lit edges.
- **Clean lines.** No doubled pixels on curves ("jaggies"), no stray single pixels ("orphans"). Curves step in consistent run lengths: 3-2-1, not 3-1-2.
- **No accidental anti-aliasing.** Do not blend edges with semi-transparent pixels. Use full alpha (0 or 255).
- **Readable silhouette.** Check the shape as a solid fill first; details come last.
- **Animation.** Keep the volume constant. Small moves (1 px) read well at low resolution. Timing tables per animation: `rule:anim.timing`.

## Rules by subject

Numeric rules, common mistakes, review lists and `write_pixels` grid templates, read on demand: `read_guide("rules")` lists the chapters and rule ids; `read_guide("rules/<chapter>")` reads one: `animation` (`rule:anim`), `characters` (`rule:char`), `tiles` (`rule:tile`), `isometric` (`rule:iso`), `vfx` (`rule:vfx`), `ui` (`rule:ui`). Read the chapter for the subject before drawing it.

## Working loop

Finish every drawing or animation task with the `check` tool. It finds off-palette colors, orphan pixels, semi-transparent pixels, empty cels inside a tag, odd frame durations and content outside the canvas, each with coordinates and a fix. Fix errors; keep a warning only on purpose and say so.


1. Block in the silhouette with one color.
2. Add base colors per material.
3. Add shadows, then highlights.
4. Outline.
5. `snapshot` and check at the zoom shown. To fix individual pixels, `read_pixels` the region of one layer, change the keys and write the rows back with `write_pixels`.
