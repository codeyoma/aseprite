# Isometric {#iso}

The 2:1 pixel line, tile footprints, face lighting and sorting. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## The 2:1 line {#iso.line}

- Receding edges step 2 px across for 1 px down, in clean pairs. Never mix 1:1 or 3:1 steps into the same edge.
- Vertical edges stay vertical. There are only three directions: the two 2:1 diagonals and straight up.
- Tiles are twice as wide as tall: 16x8, 32x16, 64x32.
- Curves (round towers, wheels) are ellipses twice as wide as tall, drawn with symmetric runs.

## Tile footprint {#iso.tile}

- A floor diamond widens by 2 px a side per row to its middle, then narrows the same way. Even widths give a 2 px top and bottom point.
- A block of footprint W stands W/2 px tall per tile of height: a 32x16 tile's cube is 32 px tall in all.
- Neighbor tiles overlap their outline by 1 px or meet edge to edge; pick one and keep it for the whole set.

## Lighting the faces {#iso.light}

- Three faces, three values: top lightest, the left face middle, the right face darkest (light from the top-left). Keep the order for every object.
- A 1 px light line along the top's front edges separates the top from the sides; the vertical front edge gets no highlight.
- Shadows fall to the lower right along the 2:1 line, the same length for objects of the same height.

## Sorting and anchors {#iso.sort}

- The engine draws back to front by footprint (x + y), then by height. Split tall objects into one-tile columns so each sorts on its own.
- A sprite's anchor is the bottom centre of its footprint, not of its image.

## Characters and directions {#iso.characters}

- Isometric "4 directions" are the diagonals (NE, SE, SW, NW); 8 adds the compass points. Mirror E/W pairs (`make-directions`).
- Walking along a tile edge moves 2 px across for each 1 px down; a walk cycle's step length must fit that.
- Every direction keeps the same height and ground row (`rule:char.views`).

## Converting top-down art {#iso.convert}

- `iso_project` turns a top-down tile into a 2:1 diamond (rotate 45 degrees, halve the height). The edges come out ragged: redraw them as clean 2:1 lines afterwards.
- `iso_grid` adds a guide layer; draw on its lines.

## Mistakes {#iso.mistakes}

| You see | Cause | Fix |
|---|---|---|
| Wobbly edges | Steps of 1 and 3 mixed in | Clean 2-across, 1-down pairs (`rule:iso.line`) |
| Objects look tilted | Vertical edges leaning | Keep verticals vertical |
| Flat blocks | Faces the same value | Top light, left mid, right dark (`rule:iso.light`) |
| Characters walk through walls | Tall objects in one piece | Split into tile columns (`rule:iso.sort`) |
| Projected tile looks blurry | `iso_project` output kept as is | Redraw the edges |

## Review {#iso.review}

- [ ] Every receding edge is a clean 2:1 line; verticals are vertical.
- [ ] Faces lit top > left > right everywhere.
- [ ] Footprints align to the grid; anchors at the footprint's bottom centre.
- [ ] Tall objects split for sorting.

## Templates {#iso.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the sprite's own colors.

### Floor diamond, 16x8 {#iso.tmpl.floor}

Keys: `o` outline, `t` top.

```grid
Legend: o=#2b2433 t=#8fae6a
. . . . . . o o o o . . . . . .
. . . . o o t t t t o o . . . .
. . o o t t t t t t t t o o . .
o o t t t t t t t t t t t t o o
o o t t t t t t t t t t t t o o
. . o o t t t t t t t t o o . .
. . . . o o t t t t o o . . . .
. . . . . . o o o o . . . . . .
```

### Block, 16x15 {#iso.tmpl.block}

Keys: `o` outline, `t` top, `l` left face, `r` right face.

```grid
Legend: o=#2b2433 t=#c9b48a l=#9a7e57 r=#6b5238
. . . . . . o o o o . . . . . .
. . . . o o t t t t o o . . . .
. . o o t t t t t t t t o o . .
o o t t t t t t t t t t t t o o
o l o o t t t t t t t t o o r o
o l l l o o t t t t o o r r r o
o l l l l l o o o o r r r r r o
o l l l l l l l r r r r r r r o
o l l l l l l l r r r r r r r o
o l l l l l l l r r r r r r r o
o l l l l l l l r r r r r r r o
o o l l l l l l r r r r r r o o
. . o o l l l l r r r r o o . .
. . . . o o l l r r o o . . . .
. . . . . . o o o o . . . . . .
```
