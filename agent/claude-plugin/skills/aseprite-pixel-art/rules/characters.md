# Characters at small sizes {#char}

Proportions, faces and readability for characters 16-48 px tall. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## Head count and head size {#char.heads}

- Head height = sprite height / heads. A face (two eyes and room around them) needs a head of at least 4 px; if the count gives less, use fewer heads, never a smaller face.
- Head count sets the tone: 2-3 cute, 3-4 the usual game hero, 5-6 grounded, 7-8 realistic (only from 48 px up).
- From 24 px up the head stays about 6-9 px; extra height goes to the torso and legs.

| Height | 2 heads | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|
| 16 | 8 | 5 | 4 | too small | too small |
| 24 | 12 | 8 | 6 | 5 | 4 |
| 32 | 16 | 11 | 8 | 6 | 5 |
| 48 | 24 | 16 | 12 | 10 | 8 |

## Proportion ladder {#char.ladder}

Rows from the top (row 0), front or side view, default build.

| Height | Heads | Head | Shoulders | Crotch | Sole | Arm | Leg | Foot |
|---|---|---|---|---|---|---|---|---|
| 16 | 2.5-3 | 0-5 | 6 | 10 | 15 | 1-2 | 2 | 2-3 x 1 |
| 24 | 3 | 0-7 | 8 | 15 | 23 | 2 | 3 | 3 x 2 |
| 32 | 3.5-4 | 0-8 | 9 | 17 | 31 | 2-3 | 3 | 4 x 2 |
| 48 | 5-6 | 0-8 | 10 | 24 | 47 | 3 | 4 | 5 x 2 |

- Landmarks keep their order at every size: elbows at the waist, wrists at the crotch, knees halfway from crotch to sole.
- Widths count the outline. Odd widths have one centre column, even widths two: pick the head's and torso's parity together.

## Faces {#char.face}

- 16 px: eyes are 1x1 or 1x2 dark pixels, 2-3 px apart, no mouth unless the pose needs one; no highlight.
- 24-32 px: eyes 1x2 or 2x2, an optional 1 px highlight; a mouth is one or two pixels of a darker skin tone, not black.
- Cute: eyes below the head's middle row, no neck, head as wide as the torso or wider.
- Expressions at 16 px live in the eyes' shape and the eyebrows' pixel, not in the mouth.

## Silhouette and readability {#char.silhouette}

- Fill the character with one color: it must still say who it is and what it is doing.
- One dominant feature (hat, hair shape, weapon, cape) that reads at 1x. Hair and headwear do most of the work at 16 px.
- At 24 px and below outline only the outer silhouette; separate inner parts by color, or the figure looks stumpy.
- Limbs at least 2 px wide counting the outline: thinner ones flicker when animated.

## Hands and feet {#char.extremities}

- 16 px: a hand is 1-2 px of skin at the arm's end; feet are 2-3 px long, pointing the way the character faces.
- 32 px: fists 2x2 to 3x3, a thumb pixel only when the hand holds something; feet 4x2 with a darker sole row.
- Feet share the ground row in every frame and every direction.

## Views and directions {#char.views}

- Every direction keeps the same height, ground row, palette and head size.
- A diagonal (three-quarter) view blends its neighbors: the far side 1 px narrower, the face turned, the far arm partly hidden.
- Back views (N) show hair and clothing seams, never a face; side views show one eye.
- Mirror only symmetric characters; an item held in one hand moves back to that hand after mirroring (`make-directions`).

## A new size is a redraw {#char.resize}

- Never scale a sprite down. Redraw it: keep the silhouette, the ground contacts and the biggest accessory; drop the rest.
- When going smaller, merge small details into the nearest large shape before removing them.

## Mistakes {#char.mistakes}

| You see | Cause | Fix |
|---|---|---|
| No face, just noise | Head under 4 px | Fewer heads (`rule:char.heads`) |
| Stumpy figure | Full interior outlines at small size | Outline the silhouette only |
| Limbs flicker in motion | 1 px limbs | 2 px including the outline |
| Lopsided head | Even head on an odd torso | Match parity (`rule:char.ladder`) |
| Black-hole eyes or mouth | Pure black in the face | Darkest skin or outline color |
| Looks like a different character turned | Height or head size changes per direction | Same rows in every view (`rule:char.views`) |

## Review {#char.review}

- [ ] Head size and rows match `rule:char.ladder` for the sprite's height.
- [ ] The silhouette alone reads; one dominant feature.
- [ ] Limbs 2+ px wide; feet on the ground row.
- [ ] Face uses no pure black and fits the head size.
- [ ] Every direction shares height, ground row and palette.

## Templates {#char.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the sprite's own colors. Keys: `o` outline, `h` hair, `s` skin, `e` eye, `c` shirt, `p` trousers, `b` boots.

### Front view, 16 px tall {#char.tmpl.front16}

About 2.7 heads: head rows 0-6, shoulders 7, crotch 10, sole 15. A starting mannequin: recolor, then add the hair shape and one accessory.

```grid
Legend: o=#1d1626 h=#6b3d2e s=#f2c29b e=#1d1626 c=#3a6fc4 p=#3b3550 b=#5a3a28
. . . o o o o . . .
. . o h h h h o . .
. o h h h h h h o .
. o h s s s s h o .
. o s e s s e s o .
. o s s s s s s o .
. . o o s s o o . .
. o c c c c c c o .
o s o c c c c o s o
o s o c c c c o s o
. o o p p p p o o .
. . o p p p p o . .
. . o p o o p o . .
. . o p o o p o . .
. o b b o o b b o .
. o o o . . o o o .
```
