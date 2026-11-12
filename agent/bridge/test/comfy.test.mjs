// ComfyUI handoff (#112): workflows with manifests, a run against a fake transport (recorded WebSocket messages,
// history and files), and pose import: one anchor, one grid, one palette, keypoints as landmarks, masks as parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindParams, listWorkflows, runWorkflow } from "../dist/comfy.js";
import { __setComfyTransportForTest } from "../dist/comfy_tools.js";
import { encodePng } from "../dist/image.js";
import { importPoses, parseKeypoints } from "../dist/pose_import.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

const GRAPH = {
  3: { class_type: "KSampler", inputs: { seed: 1 } },
  6: { class_type: "CLIPTextEncode", inputs: { text: "" } },
  10: { class_type: "LoadImage", inputs: { image: "" } },
  9: { class_type: "SaveImage", inputs: {} },
  12: { class_type: "SavePoseKpsAsJsonFile", inputs: {} },
};
const MANIFEST = {
  description: "key poses from a pose image",
  params: { prompt: { node: "6", input: "text" }, seed: { node: "3", input: "seed" }, pose: { node: "10", input: "image", image: true } },
  outputs: { 9: "image", 12: "pose" },
};

function workflowsDir() {
  const dir = mkdtempSync(join(tmpdir(), "comfy-wf-"));
  writeFileSync(join(dir, "poses.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "poses.manifest.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, "loose.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "ui-format.json"), JSON.stringify({ nodes: [], links: [] }));
  return dir;
}

/** A fake ComfyUI: records requests, answers /prompt, plays progress and success on the socket, serves history and files. */
function fakeComfy(o = {}) {
  const calls = [];
  let listener;
  return {
    calls,
    async getJson(path) {
      calls.push(["GET", path]);
      if (path === "/system_stats") return { system: { comfyui_version: "0.3.99" } };
      if (path.startsWith("/history/")) {
        return o.history ?? { p1: { status: { completed: false }, outputs: {
          9: { images: [{ filename: "pose_00001_.png", subfolder: "", type: "output" }, { filename: "pose_00002_.png", subfolder: "", type: "output" }] },
          12: { text: ["{\"people\":[]}"] },
        } } };
      }
      throw new Error("unexpected " + path);
    },
    async postJson(path, body) {
      calls.push(["POST", path, body]);
      if (path === "/prompt") {
        if (o.refuse) return { error: { message: "Prompt outputs failed validation" }, node_errors: { 6: { errors: [{ message: "Required input is missing", details: "text" }] } } };
        setTimeout(() => {
          for (const m of o.messages ?? [
            { type: "progress", data: { value: 1, max: 2, prompt_id: "p1" } },
            { type: "executing", data: { node: null, prompt_id: "p1" } },
          ]) listener(m);
        }, 5);
        return { prompt_id: "p1" };
      }
      return {};
    },
    async upload(name) { calls.push(["UPLOAD", name]); return { name: `up_${name}`, subfolder: "", type: "input" }; },
    async download(path) { calls.push(["VIEW", path]); return Buffer.from("png:" + path); },
    async listen(clientId, onMessage) { calls.push(["WS", clientId]); listener = onMessage; return { close() { calls.push(["WS-CLOSE"]); } }; },
  };
}

test("listWorkflows: API graphs with manifests; a graph without one or in UI format is a problem", () => {
  const { workflows, problems } = listWorkflows(workflowsDir());
  assert.deepEqual(workflows.map((w) => w.name), ["poses"]);
  assert.ok(problems.some((p) => /loose.json: no loose.manifest.json/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /ui-format.json: not an API-format workflow/.test(p)), problems.join("; "));
  const g = bindParams(workflows[0], { prompt: "a knight", seed: 7 });
  assert.equal(g[6].inputs.text, "a knight");
  assert.equal(g[3].inputs.seed, 7);
  assert.equal(GRAPH[6].inputs.text, "", "the stored graph is not changed");
  assert.throws(() => bindParams(workflows[0], { steps: 3 }), /no param "steps" \(params: prompt, seed, pose\)/);
});

test("runWorkflow: uploads image params, queues, waits for the socket, downloads outputs by role", async () => {
  const dir = workflowsDir();
  const w = listWorkflows(dir).workflows[0];
  const pose = join(dir, "pose.png");
  writeFileSync(pose, "x");
  const t = fakeComfy();
  const out = mkdtempSync(join(tmpdir(), "comfy-out-"));
  const progress = [];
  const b = await runWorkflow(t, w, { prompt: "knight", pose }, { outDir: out, onProgress: (p) => progress.push(p) });
  const queued = t.calls.find((c) => c[1] === "/prompt")[2];
  assert.equal(queued.prompt[10].inputs.image, "up_pose.png");
  assert.equal(queued.prompt[6].inputs.text, "knight");
  assert.equal(queued.client_id, t.calls.find((c) => c[0] === "WS")[1]);
  assert.deepEqual(progress, ["1/2"]);
  assert.deepEqual(b.files.map((f) => f.role), ["image", "image", "pose"]);
  assert.match(readFileSync(b.files[0].path, "utf8"), /filename=pose_00001_.png/);
  assert.match(b.files[2].path, /pose-text\.json$/);
  assert.ok(t.calls.some((c) => c[0] === "WS-CLOSE"));
});

test("runWorkflow: a refused graph and a failed node come back as messages", async () => {
  const w = listWorkflows(workflowsDir()).workflows[0];
  await assert.rejects(runWorkflow(fakeComfy({ refuse: true }), w, { prompt: "x" }), /ComfyUI refused the workflow: Prompt outputs failed validation node 6: Required input is missing \(text\)/);
  const failing = fakeComfy({ messages: [{ type: "execution_error", data: { prompt_id: "p1", node_id: "3", node_type: "KSampler", exception_message: "CUDA out of memory" } }] });
  await assert.rejects(runWorkflow(failing, w, { prompt: "x" }), /ComfyUI failed in node 3 \(KSampler\): CUDA out of memory/);
});

// ---------------------------------------------------------------------------
// Pose import

const S = 4; // source px per sprite px
/** A source pose: a 3x6 body block and a 1-wide arm, at (x, y) in sprite pixels, drawn at S, on transparency. */
function sourcePose(x, y, armDown = true) {
  const W = 64, H = 64, d = new Uint8Array(W * H * 4);
  const block = (bx, by, bw, bh, c) => {
    for (let yy = by * S; yy < (by + bh) * S; yy++) for (let xx = bx * S; xx < (bx + bw) * S; xx++) d.set([...c, 255], (yy * W + xx) * 4);
  };
  block(x, y, 3, 6, [40, 60, 200]);
  if (armDown) block(x + 3, y + 1, 1, 3, [220, 180, 140]);
  else block(x + 3, y + 1, 3, 1, [220, 180, 140]);
  return { width: W, height: H, data: d };
}
const kp = (x, y) => ({ neck: [(x + 1.5) * S, y * S], mid_hip: [(x + 1.5) * S, (y + 5) * S] });

test("importPoses: one scale and anchor for all poses; hips line them up; one palette; landmarks in sprite pixels", () => {
  const poses = [{ image: sourcePose(2, 4), keypoints: kp(2, 4) }, { image: sourcePose(6, 5, false), keypoints: kp(6, 5) }];
  const r = importPoses(poses, { width: 16, height: 16, scale: S });
  assert.equal(r.anchor, "hips");
  assert.equal(r.scale, 4);
  assert.equal(r.palette.length, 2);
  // The body blocks land on the same pixels in both frames (lined up by the hips), on the bottom row.
  const bodyCols = (img) => {
    const xs = new Set();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (img.data[(y * 16 + x) * 4 + 2] === 200 && img.data[(y * 16 + x) * 4 + 3]) xs.add(x);
    return [...xs].sort((a, b) => a - b);
  };
  assert.deepEqual(bodyCols(r.frames[0]), bodyCols(r.frames[1]));
  assert.deepEqual(r.landmarks[0].mid_hip, r.landmarks[1].mid_hip);
  assert.ok(r.landmarks[0].neck[1] < r.landmarks[0].mid_hip[1]);
});

test("parseKeypoints: OpenPose JSON in pixels or normalized, COCO 18 or BODY_25, mid hip filled in", () => {
  const flat = Array(18 * 3).fill(0);
  flat.splice(8 * 3, 3, 10, 50, 0.9); // r_hip
  flat.splice(11 * 3, 3, 20, 50, 0.9); // l_hip
  flat.splice(1 * 3, 3, 15, 20, 0.8); // neck
  const k = parseKeypoints({ people: [{ pose_keypoints_2d: flat }], canvas_width: 100, canvas_height: 100 }, { width: 200, height: 200 });
  assert.deepEqual(k.neck, [30, 40], "scaled from the canvas to the image");
  assert.deepEqual(k.mid_hip, [30, 100]);
  assert.equal(k.nose, undefined, "no confidence, no joint");
  const norm = parseKeypoints([{ people: [{ pose_keypoints_2d: [0.5, 0.25, 1] }] }], { width: 64, height: 64 });
  assert.deepEqual(norm.nose, [32, 16]);
  assert.throws(() => parseKeypoints({ people: [] }, { width: 1, height: 1 }), /No person in the keypoints/);
});

test("poses_to_frames: frames, the clip's keys with landmarks, and part layers cut by masks (#112)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "poses-"));
  const file = (name, img) => { const p = join(dir, name); writeFileSync(p, encodePng(img)); return p; };
  const json = (name, k) => {
    const flat = Array(18 * 3).fill(0);
    flat.splice(1 * 3, 3, ...k.neck, 1);
    flat.splice(8 * 3, 3, k.mid_hip[0] - 2, k.mid_hip[1], 1);
    flat.splice(11 * 3, 3, k.mid_hip[0] + 2, k.mid_hip[1], 1);
    const p = join(dir, name); writeFileSync(p, JSON.stringify({ people: [{ pose_keypoints_2d: flat }], canvas_width: 64, canvas_height: 64 })); return p;
  };
  // Masks: the arm's pixels (white) per pose.
  const armMask = (x, y, down) => {
    const img = sourcePose(x, y, down);
    for (let i = 0; i < img.data.length; i += 4) {
      const arm = img.data[i] === 220;
      img.data.set(arm ? [255, 255, 255, 255] : [0, 0, 0, 0], i);
    }
    return img;
  };
  const fake = fakeDocument({ width: 16, height: 16, frames: 4, tags: [{ name: "wave", from: 1, to: 4 }], layers: [{ name: "Base", frames: [] }] });
  const r = await runTool(findTool("poses_to_frames"), {
    images: [file("a.png", sourcePose(2, 4)), file("b.png", sourcePose(6, 5, false))],
    keypoints: [json("a.json", kp(2, 4)), json("b.json", kp(6, 5))],
    masks: { arm: [file("ma.png", armMask(2, 4, true)), file("mb.png", armMask(6, 5, false))] },
    tag: "wave", frames: [1, 4], scale: S, character: "Kid",
  }, fake);
  const t = r.content[0].text;
  assert.equal(r.isError, undefined, t);
  assert.match(t, /Put 2 poses on frames 1, 4 at 4 source px per pixel, lined up by the hips, one 2-color palette, on "AI: Poses" \(hidden, locked\); parts cut by their masks: arm/);
  assert.match(t, /Clip "wave": these frames are its keys, in the keys stage/);
  const st = (await fake.request("get_state")).result.activeSprite;
  const motion = JSON.parse(st.motion);
  assert.deepEqual(motion.clips.wave.keys.map((k) => k.at), [1, 4]);
  assert.ok(motion.clips.wave.keys[0].landmarks.mid_hip, JSON.stringify(motion.clips.wave.keys[0]));
  assert.equal(motion.clips.wave.stage, "keys");
  assert.deepEqual(motion.rigs.Kid.parts.map((p) => p.layer), ["AI: arm"]);
  const arm = st.layers.find((l) => l.name === "AI: arm");
  assert.deepEqual(arm.celFrames, [1, 4]);
  assert.match((await runTool(findTool("poses_to_frames"), { images: [join(dir, "nope.png")] }, fake)).content[0].text, /No file/);
});

test("comfy_workflows and comfy_run through the tools, with the fake ComfyUI", async () => {
  process.env.ASEPRITE_AGENT_COMFY_WORKFLOWS = workflowsDir();
  const t = fakeComfy();
  __setComfyTransportForTest(t);
  try {
    const list = (await runTool(findTool("comfy_workflows"), {}, fakeDocument({ width: 8, height: 8 }))).content[0].text;
    assert.match(list, /ComfyUI answers at .* \(0\.3\.99\)/);
    assert.match(list, /- poses: key poses from a pose image\n  params: prompt, seed, pose \(an image file\)\n  outputs: image, pose/);
    assert.match(list, /problem: loose.json/);
    const run = await runTool(findTool("comfy_run"), { workflow: "poses", params: { prompt: "knight" } }, fakeDocument({ width: 8, height: 8 }));
    assert.match(run.content[0].text, /ComfyUI run of "poses" \(p1\): 3 files/);
    assert.match(run.content[0].text, /- image: .*pose_00001_.png, .*pose_00002_.png/);
    assert.match((await runTool(findTool("comfy_run"), { workflow: "nope" }, fakeDocument({ width: 8, height: 8 }))).content[0].text, /No workflow "nope"/);
  } finally {
    __setComfyTransportForTest(undefined);
    delete process.env.ASEPRITE_AGENT_COMFY_WORKFLOWS;
  }
});
