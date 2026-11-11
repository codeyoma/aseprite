# Tiles {#tile}

Seamless terrain, transitions and autotile sets. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## Tile size {#tile.size}

- The game decides the size: ask. 16 px is the default; 8 and 32 are common; 48 is RPG Maker's. Sizes are even.
- One size per set. Doubling the size quadruples the pixels to fill, so a 32 px set is not "more detail" for free.

| Tile | Colors per terrain | Edge band | Sets that read |
|---|---|---|---|
| 8 | 2-3 | 2-3 px | 3x3 block + inner corners, 16-tile |
| 16 | 3-4 | 5 px | any; blob 47 is the standard |
| 32 | 4-5 | about 10 px | blob 47, 9-slice; 3-4 fill variants |

## Seamless fill {#tile.seamless}

- Draw the fill, shift it half a tile on both axes, repaint the middle (the old seams), shift back. `seamless_check` finds clashing edges; `make_seamless` fixes a few pixels.
- Judge it repeated 3x3 at 1x, never alone.
- What makes the grid show: one feature that fills the tile, a gradient across it, detail piled in a corner or along an edge, a high-contrast pixel, the same cluster repeated in a row.

## Variants {#tile.variants}

- Variants change only the middle: keep the outer 1-2 px identical to the fill so every variant joins every other.
- 3-4 variants; place the busy ones sparsely (about 1 in 8).
- Small textures (tufts, cracks, pebbles) go on a transparent layer over the fill instead of baked into every pair.

## Edges and transitions {#tile.edges}

- Cut a transition out of the two full tiles: terrain A where the mask says A, B elsewhere, then one pass along the boundary. Do not repaint either side.
- The boundary sits about a third of the tile in from the edge (5 px at 16) and wobbles 1 px in runs of 2 or more. It starts and ends at the same offset so neighbors meet.
- Light from the top-left: a light rim on the upper terrain where the edge faces up or left, a 1 px shadow on the lower terrain under edges facing down or right.

## Side-view tops {#tile.sideview}

- Grass over dirt in four bands: light rim, grass, dark underside, then a shadow row on the dirt.
- The lip hangs 1-2 px over the dirt in a few places; the collision line stays under the lip.
- Side-view strips only need to wrap horizontally.

## Autotile sets {#tile.autotile}

| Set | Tiles | For |
|---|---|---|
| 9-slice + 4 inner corners | 13 | rectangles, rooms, UI panels |
| 4-bit (cardinal neighbors) | 16 | roads, pipes, wall lines |
| Blob | 47 | terrain with inner and outer corners |

- Neighbor bits clockwise from north: N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128. A diagonal counts only when both cardinals beside it are set; that leaves 47 distinct tiles.
- `make_autotile` builds the 47 or 16 set from a 5-tile template (island, vertical, horizontal, fill, inner) and a preview map: see the `make-tileset` skill.
- Test with one lone cell, a 3x3 patch, an L shape (inner corner) and a one-tile-wide strip.

## Palette and contrast {#tile.palette}

- Tiles are quieter than sprites: lower contrast and saturation, so characters read on top.
- A palette swap of a whole set is a fair way to get a second biome.

## Tall objects {#tile.tall}

- The footprint stays on the grid; only the top may rise above it.
- Split tall things (trees, walls, towers) into tile pieces so the engine can sort them by y.

## Mistakes {#tile.mistakes}

| You see | Cause | Fix |
|---|---|---|
| A visible grid | One big feature, a gradient, or detail on the edge | Spread small clusters through the middle (`rule:tile.seamless`) |
| Tufts or pebbles in a row like a pattern | One shape at even steps along the edge | 2-3 shapes, uneven gaps, some skipped |
| Flat terrain, no height | The edge is a plain color change | A 1 px lit lip on the upper terrain and a 1 px shadow on the ground below it |
| Seams between variants | Variant edges changed | Keep the outer 1-2 px of the fill (`rule:tile.variants`) |
| Steps along a transition | Boundary offset differs at the tile's ends | Same offset at both ends (`rule:tile.edges`) |
| Characters vanish on the ground | Tiles as contrasty as sprites | Lower tile contrast (`rule:tile.palette`) |
| Broken corners in the preview | Island or inner corners off | Fix the template and rebuild |

## Review {#tile.review}

- [ ] The fill repeats 3x3 without a visible grid.
- [ ] Variants share the fill's outer 1-2 px.
- [ ] Transitions meet their neighbors at the same offset; light rim and shadow follow the top-left light.
- [ ] The autotile preview has no broken corners (lone cell, 3x3, L, strip).
- [ ] Tile contrast is below the sprites'.

## Templates {#tile.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the sprite's own colors.

### Grass fill, 16x16 {#tile.tmpl.grass}

Keys: `g` grass, `d` dark blade, `l` light blade. Small tufts in the middle, nothing on the edges, so it wraps on both axes.

```grid
Legend: g=#4f8a3c d=#356b2e l=#7cb84f
g g g g g g g g g g g g g g g g
g g g l g g g g g g g g g g g g
g g d l g g g g g g g d g g g g
g g g d g g g g g g l d g g g g
g g g g g g g g g g g g g g g g
g g g g g g g g g g g g g g g g
g g g g g g g d g g g g g g g g
g g g g g g l d g g g g g g g g
g g g g g g g g g g g g g g g g
g g l g g g g g g g g g g g g g
g g d g g g g g g g g g g l g g
g g g g g g g g g g g g d l g g
g g g g g g g g g g g g g d g g
g g g g g l g g g g g g g g g g
g g g g d l g g g g g g g g g g
g g g g g g g g g g g g g g g g
```

### Grass lip over dirt, 16x6 {#tile.tmpl.lip}

Side view, wraps horizontally. Keys: `l` light rim, `g` grass, `d` dark underside, `s` dirt in shadow, `b` dirt, `k` pebble.

```grid
Legend: l=#7cb84f g=#4f8a3c d=#356b2e s=#5a3b26 b=#7a5233 k=#94704a
l l g l l l l g l l l l l g l l
g g g g g g g g g g g g g g g g
g d g g g g d g g g g d g g g d
d s d d g d s d d g d s d d d s
s b s s d s b s s d s b s s s b
b b b k b b b b b b b b k b b b
```
