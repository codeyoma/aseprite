---
name: aseprite-comfyui
title: Key poses from ComfyUI
description: Run the user's ComfyUI workflows for key poses (images, OpenPose keypoints, part masks) or take the poses they made there, and import them as the keys of one clean animation, then make the in-betweens from them.
category: Animation
triggers: [comfyui, comfy ui, comfy, from comfyui, key poses, pose images, openpose, pose keypoints]
intents: [import poses, run comfyui, poses to frames, use these poses]
tools: [comfy_workflows, comfy_run, poses_to_frames, motion_clip, inbetween, motion_check, walk_check, snapshot, apply_timeline_text]
---
# Key poses from ComfyUI

The user makes the art in ComfyUI; here it becomes a clean animation. The poses are keys, and tools make what lies between them.

## 1. Get the poses
- **The user hands you files** (pose PNGs, maybe OpenPose JSON and part masks): use them as they are.
- **You run ComfyUI:** `comfy_workflows` lists the workflows the user saved (with what each needs and returns) and says whether ComfyUI answers. `comfy_run` with the workflow and its params (prompt, seed, a pose image file...). It returns a job id when it takes long; call it again with `job`. Its result lists the files by role: `image` (the poses), `pose` (keypoints), `mask:<part>`, `depth`.
- No workflow fits, or ComfyUI isn't running: say so in one line and ask for the files.

## 2. Plan the clip
1. Frames and tag first (`apply_timeline_text`): the motion's length and durations from `rule:anim.timing`, with the poses as its keys (extremes and contacts, about one in three frames).
2. `motion_clip` `action: "plan"` with the tag, the key frames and each key's pose.

## 3. Import
`poses_to_frames` with the images in key order, the `tag` and the key `frames`:
- `keypoints` (one OpenPose JSON per pose) line the poses up by the hips and become landmarks on the keys; without them they line up by the feet.
- `masks` (per part, one mask per pose) cut each pose into part layers and give the rig its parts, so `inbetween` can move each part. Ask for masks when the motion moves limbs: without part layers the in-betweens are drawn by hand.
- `scale` when you know the poses' pixel size (source px per sprite px); otherwise the poses fit the canvas.
All poses share one scale, one grid and one palette, so they don't jitter against each other.

## 4. Keys, then in-betweens
1. Clean each key (outlines, stray pixels, joints), `snapshot` `view: "filmstrip"`. For a walk, `walk_check`.
2. `motion_clip` `action: "rig"` with the part layers (root first) when the masks made parts, and check the joints it suggests.
3. `motion_clip` `action: "advance"`, then `inbetween` (it fills every gap between the keys and keeps them as they are).
4. `motion_check`, `snapshot` `view: "trails"`; fix what they list, then `motion_clip` `action: "done"`.

Then: `review`, then `export-game` for a game.

<skill-tools>
Tools this skill uses that are not in your tool list: call them with call_tool, e.g. call_tool({ name: "comfy_workflows", input: { ... } }). Their inputs:
- comfy_workflows {}: List the user's ComfyUI workflows the agent may run (#112): each one's name, what it does, its params and its outputs by role (image, pose, mask:<part>, dept…
- comfy_run {workflow?: string, params?: object, job?: string}: Run one of the user's ComfyUI workflows (#112) with params (a prompt, a seed, a pose image file...) and get its files back by role in the session folder: key…
- poses_to_frames {images: [string], keypoints?: [string], masks?: object, frames?: [integer], tag?: string, size?: [integer 4-512, integer 4-512], scale?: number 1-64, anchor?: "hips"|"feet"|"source", colors?: integer 2-64, layer?: string, character?: string}: Import key poses made elsewhere (ComfyUI: one PNG per pose) as frames of one animation (#112), in one undo step.
- motion_clip {action?: "show"|"plan"|"advance"|"done"|"rig"|"remove", tag?: string, kind?: "walk"|"run"|"idle"|"cycle"|"action", facing?: "right"|"left", loop?: boolean, keys?: [integer|object], contacts?: [integer], root_travel?: number, followers?: [object], character?: string, staged?: boolean, base_frame?: integer, parts?: [object]}: The animation's plan as data on the sprite (#109), one clip per tag: kind, facing, loop, key frames with their poses, contacts, root travel and followers (ha…
- inbetween {tag?: string, from?: integer, to?: integer, parts?: [string], easing?: "linear"|"ease-in"|"ease-out"|"ease-in-out", arc?: number}: Make the frames between approved keys (#110): each part layer is solved as a rigid move between its two keys (a turn about its joint, where it meets its pare…
- motion_check {tag?: string, parts?: [string]}: Measure how an animation moves (#111): per part (its layer) and for the whole figure in every frame of the tag, the spacing (px a frame: even, eased or poppi…
- walk_check {tag?: string, facing?: "right"|"left", contacts?: [integer, integer], near_arm?: object, near_leg?: object}: Check a side-view walk's arms against its legs on the two contact frames: the near arm must swing opposite the near leg, and each must change sides between t…
- apply_timeline_text {text: string, plan?: boolean}: Change the timeline to match the text, in one undo step.
</skill-tools>
