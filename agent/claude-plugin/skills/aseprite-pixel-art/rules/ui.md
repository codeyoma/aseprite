# UI and icons {#ui}

Pixel text, buttons, panels, bars and icons. Cite a rule as `rule:<id>`; read one section with `read_guide("<id>")`.

## Scale {#ui.scale}

- Draw UI at the game's native resolution and scale by whole numbers (2x, 3x). A fractional scale doubles some pixels and not others.
- Sizes follow the game's grid: 8 or 16 px units for panels and icons.

## Text {#ui.text}

| Font height | Use |
|---|---|
| 3x5 | digits and short labels (scores, counters) |
| 5 px ('mini') | small labels |
| 7 px ('aseprite') | menus, dialogue |
| 8-16 px | titles; `draw_text` `scale` 2-3 |

- 1 px between letters, at least 2 px between lines; never anti-aliased.
- On a busy background give text a 1 px outline or a drop shadow one step darker than the background.
- A TTF pixel font only at its design size (often 8 or 16).

## Buttons and panels {#ui.panels}

- Border: the darkest palette color. Bevel: highlight one step lighter than the fill on the top and left, shadow one step darker on the bottom and right.
- Padding 3-4 px around a label. The 9-slice corner is the border plus the bevel (3-4 px); the middle stretches.
- States: normal; hover (fill one step lighter); pressed (highlight and shadow swapped, label 1 px down); disabled (desaturated, lower contrast, no bevel). `make_ui` makes all four.

## Bars {#ui.bars}

- 4-6 px tall at 16 px game scale: border, fill, empty. The fill's top row one step lighter.
- The fill's hue says what it is (red health, blue mana, yellow stamina); also give a shape or label cue, since color alone is not enough.
- Damage: a lighter chunk stays where the fill was and drains after 300-500 ms.

## Icons {#ui.icons}

- 16x16 is the default (8, 12, 24, 32 also common), with 1 px free inside the cell so neighbors don't touch.
- A 1 px outline, top-left light, 4-6 colors; the silhouette tells the item without its colors.
- Icons in one set share size, outline color, light direction and how much of the cell they fill.

## Contrast and palette {#ui.contrast}

- UI uses the game's palette (`palette_from_image`), not new colors.
- Text and its background at least four ramp steps apart.

## Mistakes {#ui.mistakes}

| You see | Cause | Fix |
|---|---|---|
| Uneven pixels | Fractional scale | Whole-number scale (`rule:ui.scale`) |
| Blurry text | Anti-aliased font, or a TTF off its size | Pixel font at its size (`rule:ui.text`) |
| Corners stretch | 9-slice corner smaller than border + bevel | Corner = border + bevel (`rule:ui.panels`) |
| Pressed state looks the same | Only the fill changed | Swap bevel, move the label 1 px down |
| Icons look mismatched | Different outlines or light | One outline color and light for the set (`rule:ui.icons`) |

## Review {#ui.review}

- [ ] Whole-number scale; text never anti-aliased.
- [ ] Four button states that differ at a glance.
- [ ] 9-slice corners hold the whole border and bevel.
- [ ] Bars and icons use the game's palette; meaning not by color alone.

## Templates {#ui.templates}

Grids are in the `write_pixels` format: pass the `Legend:` line as `legend` and the rows as `rows`, after mapping the keys to the game's palette. Keys: `o` border, `h` highlight, `f` fill, `s` shadow.

### Button, normal, 12x7 {#ui.tmpl.button}

Slice corners 2x2; the middle stretches.

```grid
Legend: o=#1b1724 h=#8fb3e8 f=#4d7cc7 s=#2e4f8f
. o o o o o o o o o o .
o h h h h h h h h h h o
o h f f f f f f f f s o
o h f f f f f f f f s o
o h f f f f f f f f s o
o s s s s s s s s s s o
. o o o o o o o o o o .
```

### Button, pressed, 12x7 {#ui.tmpl.button-pressed}

Bevel swapped; a label would sit 1 px lower.

```grid
Legend: o=#1b1724 h=#8fb3e8 f=#4d7cc7 s=#2e4f8f
. o o o o o o o o o o .
o s s s s s s s s s s o
o s f f f f f f f f h o
o s f f f f f f f f h o
o s f f f f f f f f h o
o h h h h h h h h h h o
. o o o o o o o o o o .
```

### Health bar, 14x4 {#ui.tmpl.bar}

Keys: `o` border, `l` fill top, `r` fill, `e` empty.

```grid
Legend: o=#1b1724 l=#ff7a6b r=#d63a3a e=#3a2a3a
. o o o o o o o o o o o o .
o l l l l l l l l e e e e o
o r r r r r r r r e e e e o
. o o o o o o o o o o o o .
```

### Digits 0 1 2, 3x5 {#ui.tmpl.digits}

Key: `w` text.

```grid
Legend: w=#f4f0e8
w w w . . w . . w w w
w . w . w w . . . . w
w . w . . w . . w w w
w . w . . w . . w . .
w w w . w w w . w w w
```
