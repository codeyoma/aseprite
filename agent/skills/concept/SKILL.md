---
name: concept
title: Concept first, then pixels
description: Before drawing a new character, prop or animation from words, write an art spec and a ready-to-paste prompt for an image model (a concept sheet or a storyboard); turn the image the user brings back into a pixel spec and reference frames, then draw to it and fix the largest mismatches.
category: Drawing
triggers: [concept, concept sheet, storyboard, image model, design first, reference frames, pixel spec]
tools: [concept_spec, pixel_spec, storyboard_to_frames, mismatch_regions, snapshot, get_state, read_guide, write_pixels, read_pixels, execute_lua, check]
---
# Concept first, then pixels

Inventing a design and placing every pixel at the same time is where drawn-from-nothing pixel art goes wrong. Split it: an image model (ChatGPT, Gemini, Midjourney, ... whatever the user has) designs the look and the key poses; you turn that design into pixels. The image is a guide for proportions, poses and color masses, never the pixels themselves: a scaled-down concept is blurry noise, not pixel art.

Skip this skill for edits to art that already exists. If the user already attached concept art or a storyboard, go straight to step 4.

## 1. Art spec
Write it in a few lines; it binds both the prompt and your drawing:
- **Subject**: what it is, one line of character, and for an animation what happens from first to last frame.
- **Target**: canvas W x H, how many pixels tall the subject is, view and facing, light direction, outline style.
- **Silhouette**: how many heads tall, and the two or three shapes that must read at 1x (a pointed hat, a long coat, an oversized sword).
- **Palette**: exact hex colors with their roles (outline, skin ramp, cloth ramp, metal, accent). Use the sprite's palette when one is set (`get_state`).
- **Animation**: frame count, one line per key pose, timing in ms, loop or one-shot (`read_guide("rules/animation")`). The storyboard's panels are these keys.
- **Not wanted**: text, scenery, props nobody asked for, camera changes between panels.

## 2. Prompt for the image model
Write it in English, filled in completely (no `{placeholders}` left), in one fenced code block so it copies in one go. The layout lines are what make the image sliceable, so keep them: equal panels in one row, each panel is the whole canvas, same scale and ground line everywhere, flat plain background, no text.

A **storyboard** (one panel per frame):
```
Pixel art animation storyboard: <subject> doing <action>, <N> frames.
<view> view, facing <direction>, fixed camera, light from the <side>.
Look: low-resolution pixel art, the character about <height> px tall on a <W>x<H> sprite, hard pixel edges, no anti-aliasing, <outline style> outline.
Use only these colors: <hex list with roles>.
Layout: exactly <N> square panels in one horizontal row, equal size, no gaps. Each panel is the whole <W>x<H> canvas, drawn at the same scale with the feet on the same ground line, so the character's position in each panel is its position in that frame. Panels left to right:
1. <key pose 1>
2. <key pose 2>
...
Flat plain white background, no motion lines, no text, no numbers, no borders.
```
A **concept sheet** for a character or prop is the same with views instead of poses (front, side, back) and one line on the subject's look. For an animated character, offer both: the sheet fixes the design, the storyboard fixes the motion.

## 3. Offer the choice, once
In the same message as the spec and prompt, ask which way to go:
1. **"I'll generate it"**: the user pastes the prompt into their image model and attaches the result (or gives its path). Stop and wait; don't start drawing.
2. **"Continue without"**: go to step 5 and write the pixel spec from the art spec alone; it still binds the drawing.

## 4. Read the image into a pixel spec
1. `concept_spec` with the image path, `target_size` and `panels` (`{cols, rows}` as the prompt asked, or `"auto"`). It measures each panel's silhouette in target pixels (bounds `[x0,y0,x1,y1]`, center, top, feet) and guesses color roles, and returns a JSON skeleton.
2. Look at the image yourself, then complete the skeleton: a `pose` per frame, the `eyes`, `hands` and `weapon_tip` landmarks in target pixels (null when not visible), the palette roles mapped onto the sprite's palette (don't adopt the image's colors: an image model's "few colors" are dozens), and `deviations`: what you simplify or drop on purpose at this size ("belt buckle dropped: one pixel is noise").
3. Store it with `pixel_spec` (`spec`: the completed object). Later steps and reviews read it back with `pixel_spec` and no arguments.

## 5. Reference frames (storyboards)
1. Open or make the sprite at the target size with one empty art layer, then `storyboard_to_frames` with the image and `panels`. Panel i goes onto frame i of a hidden, locked `AI: Reference` layer, frames are added as needed, all in one undo step, and the art layer stays active. Pass the completed spec as `spec` to store it in the same step. Use `show: "faint"` only when the user wants to trace over it in Aseprite.
2. Check frame 1 with `snapshot` `view: "compare"` (REF left, ART right): a cut-off or wrong panel means the grid is wrong; fix it now, not after drawing.

## 6. Draw, then compare and fix
1. Draw each frame on the art layer (never on the reference), following the spec's bounds, landmarks and palette, with the usual drawing tools. The reference gives placement and proportion; the pixels are yours, clean and on the palette.
2. `mismatch_regions` (`top: 5`): per frame the overlap and how far the art's center is from the reference's, then the largest areas where only the reference has shape (`missing`) or only the art does (`extra`), with bounds.
3. Fix those 3 to 5 regions, nothing else, then run `mismatch_regions` and `snapshot` `view: "compare"` again. Stop when what remains is listed in `deviations`; two rounds is normal.
4. `check`, then report the frames, what each shows, and the deviations you kept. The reference layer is hidden and locked; delete it before export if the user doesn't want it in the file.

## Never
- Use the reference's pixels as the art: no copying it with `read_pixels`/`write_pixels`, no recoloring it into the palette. Draw it.
- Ask for the image twice, or hide the prompt inside a paragraph.
- Let the image overrule the spec: if the model changed the view or added a cape nobody wanted, the spec wins; note it as a deviation.

Adapted from aseprite-ai-artist's concept skill (MIT, https://github.com/with-pebbly/aseprite-ai-artist).
