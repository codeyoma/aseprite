---
name: aseprite-character-motions
title: Character motions on one sprite
description: Build a character as body-part layers from the image generator, then add motions (idle, walk, run, attack, guard, hit, jump, lie down) as tagged frame ranges after a base pose, each generated as sprite sheets per layer and cut into frames.
category: Animation
triggers: [character, new character, motion, moves, attack motion, guard motion, add a motion, motion set, move set, sword swing, slash animation]
intents: [character, motion, swing]
tools: [ask_user, generate_character, apply_timeline_text, get_timeline_text, motion_stage, walk_check, motion_review, transform_layer, rotate_layer, check, snapshot, read_guide]
---
# Character motions on one sprite

One sprite holds one character: a **base pose**, then one **tag per motion** (idle, walk, run, attack, guard, hit, jump, lie down...). The character is built from **part layers** in a group `AI: <name>`. Every motion reuses those layers, so the design and limb sizes stay the same across motions. The pixel spec remembers the character (`characters.<name>`: its layers, palette, reference layer, base frame and master sheets).

## 1. Read what exists
`get_state` and `get_timeline_text`: the tags, the frame count, and whether the character already has a group and a `characters` entry in the pixel spec. If so, skip to step 3.

## 2. A new character: ask how finely to split it, then build the base
1. `ask_user`, then end your turn and wait for the answer. Ask: "How finely should I split <name> into layers?" Offer three answers:
   - "8 rough layers (hair, head, eyes, torso, near/far arm, near/far leg)", first, as the recommendation;
   - "Detailed (also hands, face parts, clothing pieces)";
   - "Rough plus <what the request needs>", e.g. "katana and slash effect".
2. Build the layer list from the answer, bottom to top. Weapons and clothing pieces are layers of their own. Effects (a slash trail, sparks, dust) get `effect: true`. At most 12 layers. Each layer's `part` names it for the image model: "the katana, its blade and grip", "the slash trail effect".
3. The base pose: `generate_character` with one pose (standing, the view the user wants), `frames: [1]`, `name`. Tag frame 1 `base` (or keep it as the first frame of `idle`).

## 3. Add a motion after the existing frames
1. **Frames.** Take the count and the durations from `read_guide("rules/animation")` (`rule:anim.timing`) unless the user gave them. Append them after the last frame, with the motion's tag, in one `apply_timeline_text` (for example frames 2-9, tag `attack`). Leave the earlier motions where they are.
2. **Poses.** Write one line per frame: what the body, the weapon and the effect do in that frame (anticipation, swing, follow-through, recovery).
3. **Up to 9 frames: one round.** `generate_character` with every frame's pose, `frames` the new frame numbers, `tag`, `name`, and the character's layers plus any the motion needs (a weapon, an effect). Each layer's one image holds that part in every frame, and the tool cuts it into the frames. The base pose goes along as the reference.
4. **More than 9 frames: keys, then in-betweens.**
   1. Split the motion into 8 keys spaced evenly (24 frames: every 3rd, frames 1, 4, 7 ... 22 of the tag). Generate them first, with `tag`, which starts the motion stage.
   2. Check the keys (`walk_check` for a walk or run, `motion_review`, a filmstrip), then `motion_stage` `action: "advance"`.
   3. Generate the frames between the keys in rounds of up to 9: `generate_character` with `inbetweens: true` and those frames. Describe each pose as between its two keys ("halfway from key 4 to key 7, the blade at shoulder height").
5. **Clean.** Every part layer is a draft. Join the joints, redraw broken outlines, keep the palette, and remove stray pixels. A missing or misaligned part: redraw it from the reference.
6. **Check.** `check` with the tag's frames, `snapshot` `view: "filmstrip"` with the tag. A walk or run also needs `walk_check`, then `motion_review`. Then `motion_stage` `action: "done"`.
7. **Report** the motion's tag and frames, what each frame shows, and the layers that were added.

## Rules
- New motions reuse the character's group, palette and layer names. Never redraw the base pose or start a new character for a new motion.
- Each layer is generated once per round. One image holds all of that layer's frames in the round; never one image per frame.
- Effects only appear in the frames they belong to, on their own layer above the body.
- If the user declines the image generator, draw the motion yourself on the same part layers: keys first, then in-betweens by moving and rotating parts (`transform_layer`, `rotate_layer`).

Then: `review`, then `export-game` for a game.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "generate_character", input: { ... } }). Their inputs:
- generate_character {subject?: string, view?: string, poses?: [string], frames?: [integer], tag?: string, target_size?: [integer 1-512, integer 1-512]|object, layers?: [object], colors?: integer 4-64, name?: string, reference?: boolean, base_frame?: integer, inbetweens?: boolean, job?: string}: A new character as body-part layers from the image generator (#103): first a master sheet with the whole character in every key pose, then one image per laye…
- apply_timeline_text {text: string, plan?: boolean}: Change the timeline to match the text, in one undo step.
- get_timeline_text {}: The active sprite's timeline as compact text: frame count, frame durations, tags (range, direction, repeats) and linked cels.
- motion_stage {action?: "keys"|"advance"|"done", tag?: string, keys?: [integer], walk?: boolean}: Draw an animation in stages (#99).
- walk_check {tag?: string, facing?: "right"|"left", contacts?: [integer, integer], near_arm?: object, near_leg?: object}: Check a side-view walk's arms against its legs on the two contact frames: the near arm must swing opposite the near leg, and each must change sides between t…
- motion_review {tag?: string}: A fresh critic looks at a walk's two contact frames (enlarged, no measurements, no brief) and says which arm it notices, which leg it pairs with that arm, an…
- transform_layer {layer: string, from_frame: integer, to_frame: integer, move: object, arc?: number, easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out"}: Animate a rigid part (a layer: an arm, a sword, a whole small sprite) from its drawing in from_frame through to_frame: each frame gets the drawing moved/rota…
- rotate_layer {layer: string, frames: [integer], angle: number, pivot_x?: number, pivot_y?: number}: Rotate a layer's drawing in some frames by an angle around a pivot, RotSprite-style (clean edges, no new colors).
</skill-tools>
