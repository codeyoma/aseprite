---
name: aseprite-character-motions
title: Character motions on one sprite
description: Build a character as body-part layers from the image generator, then add motions (idle, walk, run, attack, guard, hit, jump, lie down) as tagged frame ranges after a base pose, each generated as sprite sheets per layer and cut into frames.
category: Animation
triggers: [character, new character, motion, moves, attack motion, guard motion, add a motion, motion set, move set, sword swing, slash animation]
intents: [character, motion, swing]
tools: [ask_user, generate_character, apply_timeline_text, get_timeline_text, motion_clip, walk_check, motion_review, inbetween, transform_layer, check, snapshot, read_guide]
---
# Character motions on one sprite

One sprite holds one character: a **base pose**, then one **tag per motion** (idle, walk, run, attack, guard, hit, jump, lie down...). The character is built from **part layers** in a group `AI: <name>`. Every motion reuses those layers, so the design and limb sizes stay the same across motions. The pixel spec remembers the character (`characters.<name>`: its layers, palette, reference layer, base frame and master sheets), and the motion store keeps its rig (`motion_clip` `action: "rig"`: part layers, parents and joints) and one clip per motion (keys, poses, contacts, stage).

## 1. Read what exists
`get_state` and `get_timeline_text`: the tags, the frame count, and whether the character already has a group and a `characters` entry in the pixel spec. If so, skip to step 3.

## 2. A new character: settle how finely to split it, then build the base
1. **Studio run or a whole job in one go** ("make a knight with a walk cycle for Godot"): use 8 rough layers plus what the request needs, say so in one line, and go straight on. **Only this character, step by step:** `ask_user`, then end your turn and wait for the answer. Ask: "How finely should I split <name> into layers?" Offer three answers:
   - "8 rough layers (hair, head, eyes, torso, near/far arm, near/far leg)", first, as the recommendation;
   - "Detailed (also hands, face parts, clothing pieces)";
   - "Rough plus <what the request needs>", e.g. "katana and slash effect".
2. Build the layer list from the answer, bottom to top. Weapons and clothing pieces are layers of their own. Effects (a slash trail, sparks, dust) get `effect: true`. At most 12 layers. Each layer's `part` names it for the image model: "the katana, its blade and grip", "the slash trail effect".
3. The base pose: `generate_character` with one pose (standing, the view the user wants), `frames: [1]`, `name`. Tag frame 1 `base` (or keep it as the first frame of `idle`).

## 3. Add a motion after the existing frames
1. **Frames.** Take the count and the durations from `read_guide("rules/animation")` (`rule:anim.timing`) unless the user gave them. Append them after the last frame, with the motion's tag, in one `apply_timeline_text` (for example frames 2-9, tag `attack`). Leave the earlier motions where they are.
2. **Poses.** Write one line per frame: what the body, the weapon and the effect do in that frame (anticipation, swing, follow-through, recovery).
3. **Keys first, every motion (#109).** Pick the keys: the extremes and the poses that carry the motion (a walk's contacts and passings, an attack's anticipation, hit and recovery; at most 9, about one in three frames of a long motion). `motion_clip` `action: "plan"` with the tag, the keys and each key's pose, then `generate_character` with the keys' poses, `frames` the keys, `tag` and `name`, and the character's layers plus any the motion needs (a weapon, an effect). Each layer's one image holds that part in every key, and the tool cuts it into the frames. The base pose goes along as the reference.
4. **Check the keys, then the in-betweens.**
   1. `walk_check` for a walk or run, `motion_review`, a filmstrip; then `motion_clip` `action: "advance"`.
   2. Make the frames between the keys from the keys on both sides: `inbetween` solves each part layer's move between the two keys (joints joined, keys untouched); for parts that change shape (it says which), generate them in rounds of up to 9 with `generate_character` `inbetweens: true`, each pose described as between its two keys ("halfway from key 4 to key 7, the blade at shoulder height").
5. **Clean.** Every part layer is a draft. Join the joints, redraw broken outlines, keep the palette, and remove stray pixels. A missing or misaligned part: redraw it from the reference.
6. **Check.** `check` with the tag's frames, `snapshot` `view: "filmstrip"` with the tag. A walk or run also needs `walk_check`, then `motion_review`. Then `motion_clip` `action: "done"`.
7. **Report** the motion's tag and frames, what each frame shows, and the layers that were added.

## Rules
- New motions reuse the character's group, palette and layer names. Never redraw the base pose or start a new character for a new motion.
- Each layer is generated once per round. One image holds all of that layer's frames in the round; never one image per frame.
- Keys before in-betweens, for every motion: the keys stage of the motion's clip refuses any other frame until it advances.
- Effects only appear in the frames they belong to, on their own layer above the body.
- If the user declines the image generator, draw the motion yourself on the same part layers: keys first, then in-betweens with `inbetween`.

Then: `review`, then `export-game` for a game.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "generate_character", input: { ... } }). Their inputs:
- generate_character {subject?: string, view?: string, poses?: [string], frames?: [integer], tag?: string, target_size?: [integer 1-512, integer 1-512]|object, layers?: [object], colors?: integer 4-64, name?: string, reference?: boolean, base_frame?: integer, inbetweens?: boolean, job?: string}: A new character as body-part layers from the image generator (#103): first a master sheet with the whole character in every key pose, then one image per laye…
- walk_check {tag?: string, facing?: "right"|"left", contacts?: [integer, integer], near_arm?: object, near_leg?: object}: Check a side-view walk's arms against its legs on the two contact frames: the near arm must swing opposite the near leg, and each must change sides between t…
- motion_review {tag?: string}: A fresh critic looks at a walk's two contact frames (enlarged, no measurements, no brief) and says which arm it notices, which leg it pairs with that arm, an…
- transform_layer {layer: string, move: object, frames?: [integer], from_frame?: integer, to_frame?: integer, arc?: number, easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out"}: Move, turn, scale or squash a rigid part (a layer: an arm, a sword, a whole small sprite), RotSprite-style: pixels stay clean and no new colors appear.
</skill-tools>
