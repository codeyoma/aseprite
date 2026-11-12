# ComfyUI with the agent

You make key art and key poses in ComfyUI; the agent imports them into Aseprite and animates them (#112). It can also run your saved workflows itself.

## Where things go

- **Workflows:** `~/.aseprite-agent/comfy/workflows/` (the dev instance: `~/.aseprite-agent-dev/comfy/workflows/`), or the folder in `comfy.json`'s `workflows` or `ASEPRITE_AGENT_COMFY_WORKFLOWS`.
- **Server:** `http://127.0.0.1:8188` by default; `comfy.json`'s `url` or `ASEPRITE_AGENT_COMFY_URL` changes it.
- **`comfy.json`** (in the agent home): `{ "url": "...", "workflows": "...", "imageWorkflow": "<name>" }`. With `imageWorkflow`, `generate_image` and `generate_character` run that workflow instead of Codex.
- **Outputs:** each run's files land in `<agent home>/comfy/runs/<prompt id>/`, named by role.

## Saving a workflow for the agent

1. In ComfyUI, save the workflow with **Export (API)** as `<name>.json` in the workflows folder.
2. Beside it, write `<name>.manifest.json`, naming the inputs the agent may set and what each output node is:

```json
{
  "description": "four key poses of a character from a pose sheet",
  "params": {
    "prompt": { "node": "6", "input": "text" },
    "seed": { "node": "3", "input": "seed" },
    "pose": { "node": "10", "input": "image", "image": true, "description": "an OpenPose skeleton image" }
  },
  "outputs": {
    "9": "image",
    "12": "pose",
    "15": "mask:near arm",
    "16": "mask:torso"
  }
}
```

`image: true` marks a parameter that takes a local file: the agent uploads it and puts the uploaded name in the node. Output roles: `image` (the poses), `pose` (OpenPose keypoints JSON), `mask:<part>` (one per body part), `depth`, `frames`.

`comfy_workflows` lists what the agent sees, with any problem (a graph saved in UI format, a missing manifest, a node id that is not in the graph).

## What makes clean frames

- **One pose per image, on transparency** (a background-removal node before saving). Without alpha the agent keys out the background.
- **The same canvas and character size for every pose**, so one scale fits them all.
- **OpenPose keypoints** (DWPose or OpenPose preprocessor plus a node that saves keypoints as JSON): the poses line up by the hips, and the joints become landmarks on the clip's keys.
- **A mask per part** (segmentation, one per part prompt): each pose is cut into part layers, which is what lets `inbetween` move each limb. Without part layers the in-betweens are drawn by hand.
