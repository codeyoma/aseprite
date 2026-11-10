---
name: aseprite-make-ui
title: Pixel text and UI
description: Make pixel UI for games (buttons with states, panels, bars, labels) and draw crisp pixel text, with 9-patch slices engines can stretch.
category: UI
triggers: [button, ui, panel, menu, hud, health bar, pixel text, pixel font, title text, 9-slice, nine slice]
tools: [make_ui, draw_text, palette_from_image, execute_lua, snapshot]
---
# Pixel text and UI

1. Use the game's palette: read it with `palette_from_image` (or the sprite palette) and pass explicit colors: `fill`, `border` (the darkest), `highlight` (one step lighter than the fill), `shadow` (one step darker), `label_color` (the lightest). Don't rely on the defaults when the user asked for a palette.
2. Buttons: `make_ui` with `kind: "button"`, a label, and a size that fits it (text is 7 px tall with the 'aseprite' font, 5 px with 'mini'; leave 3–4 px around it). It makes normal, hover, pressed and disabled frames and a 9-patch slice.
3. Panels and windows: `make_ui` with `kind: "panel"`; the slice's center stretches, so a small panel (e.g. 24x24) is enough for any size in the engine.
4. Text on a sprite (titles, scores, signs): `draw_text` with an outline or shadow when it sits on a busy background; `align: "center"` to center on x; `scale` 2–3 for titles.
5. Bars (health, mana): draw with `execute_lua` as a panel frame plus a fill rectangle per state, or ask whether a 9-patch panel plus a fill is enough.
6. `snapshot` everything and reply with the sizes and slice names for the engine.
