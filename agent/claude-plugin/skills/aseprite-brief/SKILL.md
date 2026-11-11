---
name: aseprite-brief
title: Brief before drawing
description: Settle size, palette, view, light, outline and destination in one message, stated as decisions, before an open-ended sprite is drawn; ask only what truly blocks you, then hold every later step to them.
category: Planning
triggers: [art brief, sprite brief, write a brief, brief first]
tools: [get_state, list_palettes, read_guide, snapshot]
---
# Brief before drawing

"Make me a knight" leaves open every choice that decides whether the sprite is usable. Guessing them silently and drawing wastes a redraw when a guess is wrong; asking five questions wastes the user's time. Decide all six, say them in one message, and go on.

## The six decisions

| Decision | Why it comes first | Default when nothing says otherwise |
|---|---|---|
| **Size** | It sets how much the sprite can show: head size, face, limbs (`rule:char.heads`, `rule:char.ladder`). | 32x32 for a character, 16x16 for an item or tile |
| **Palette** | A palette chosen later means repainting every ramp. | The open sprite's palette; else a named one such as PICO-8 (`list_palettes`) |
| **View** | Side, top-down, three-quarter and isometric are different drawings (`rule:char.views`, `rule:iso.characters`). | Side view for a platformer, three-quarter for top-down games |
| **Light** | Shading and outline colors follow it (`rule:iso.light` for isometric). | From the upper left |
| **Outline** | It changes every edge; small sprites outline only the silhouette (`rule:char.silhouette`). | 1 px dark, selective (selout) |
| **Destination** | An engine wants tags, a pivot and a sheet; a still image wants none of that. | The engine the user named (Godot, Unity, Phaser, Tiled), else a PNG/GIF export |

For an animation, add the frame count and timing from `rule:anim.budget` and the `rule:anim.timing` table (a walk: `rule:anim.timing.walk`). For tiles, the tile size from `rule:tile.size`.

## Steps

1. **Read what exists.** `get_state`: an open sprite's size and palette usually answer two decisions, and matching the user's project beats any default. `snapshot` it when the art is part of the request.
2. **Fill the table** from the user's words, then the open sprite, then the defaults. Infer what the request already says: "Game Boy style" settles the palette and the size range; "for Godot" settles the destination.
3. **Say it in one message, as decisions, not questions.** This is your first message of the turn, written as reply text the user reads in the chat (your thinking is hidden from them), before your next tool call. One line per decision, then one line on what you will draw. For example:

   > Size 32x32. Palette PICO-8. View: side, facing right. Light from the upper left. Outline: 1 px dark, selective. Destination: Godot, a sheet with a SpriteFrames resource. A knight in plate armor with a sword, 6-frame walk. Tell me if any of that is wrong; I am starting.

4. **Ask only what truly blocks you.** A question is worth a round trip only when no default is safe and a wrong guess means redoing the work: the game's tile size when the sprite must fit a grid, a palette the user said they have but did not give. Light direction is never one of them. When nothing blocks you, do not end the turn: go on with the next step.
5. **Hold to it.** Every later step follows the brief: the canvas is the size you stated, colors come from the palette you named, shading follows the light, the export goes to the destination. If you must depart from it (the knight does not read at 16 px), say so when it happens and list it in your final report.

Then: draw it following `pixel-art` (a new sprite: `recipes`), then `shade-sprite`, or `studio` for the whole chain.

Adapted from aseprite-ai-artist's brief skill (MIT, https://github.com/with-pebbly/aseprite-ai-artist).

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "list_palettes", input: { ... } }). Their inputs:
- list_palettes {source?: "all"|"user"|"aseprite"|"lospec", search?: string}: The palettes available by name: the user's, Aseprite's, and Lospec palettes already fetched (each with its author and URL), plus the aliases for common ones …
</skill-tools>
