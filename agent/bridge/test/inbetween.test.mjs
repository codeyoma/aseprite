// Key-to-key inbetweener (#110): rigid parts solved between two keys, sampled with easing, children carried by
// their parent, followers late, keys untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, compose, inbetweens, invert, partial, pivotOf, solveParts, solveRigid } from "../dist/inbetween.js";
import { silhouette } from "../dist/motion_analysis.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

const W = 24;
const RED = [200, 40, 40], BLUE = [40, 40, 200], GREEN = [40, 160, 40];
const img = (pts, color = RED) => {
  const d = new Uint8Array(W * W * 4);
  for (const [x, y] of pts) if (x >= 0 && y >= 0 && x < W && y < W) d.set([...color, 255], (y * W + x) * 4);
  return { width: W, height: W, data: d };
};
const rect = (x0, y0, w, h) => {
  const out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
  return out;
};
const torso = rect(8, 4, 4, 8); // x 8-11, y 4-11
// An arm 2 px wide, 7 long, hanging from the shoulder at (12, 4..5) down, or pointing right.
const armDown = rect(12, 5, 2, 7);
const armRight = rect(12, 4, 7, 2);

test("rigid maps: compose, invert, the pivot of a turn, and a partial turn stays on its arc", () => {
  const m = { angle: 90, t: [10, 0] };
  const p = [3, 4];
  const back = apply(invert(m), apply(m, p));
  assert.ok(Math.abs(back[0] - 3) < 1e-9 && Math.abs(back[1] - 4) < 1e-9);
  const c = compose(m, m);
  assert.equal(c.angle, 180);
  const o = pivotOf(m);
  const fixed = apply(m, o);
  assert.ok(Math.abs(fixed[0] - o[0]) < 1e-9 && Math.abs(fixed[1] - o[1]) < 1e-9, "the pivot does not move");
  const half = apply(partial(m, 0.5), p);
  assert.ok(Math.abs(Math.hypot(half[0] - o[0], half[1] - o[1]) - Math.hypot(p[0] - o[0], p[1] - o[1])) < 1e-9, "same distance from the joint");
});

test("solveRigid: an arm swung from down to forward is a -90° turn about the shoulder, with a good fit", () => {
  const r = solveRigid(img(armDown), img(armRight));
  assert.ok(Math.abs(r.map.angle + 90) <= 2, JSON.stringify(r));
  assert.ok(r.fit >= 0.7, JSON.stringify(r));
  const joint = pivotOf(r.map);
  assert.ok(Math.abs(joint[0] - 13) <= 1.5 && Math.abs(joint[1] - 5) <= 1.5, `joint ${joint}`);
});

test("inbetweens: eased, the same size, the joint stays on the torso, colors only from the keys", () => {
  const parts = [
    { layer: "torso", a: img(torso, BLUE), b: img(torso, BLUE) },
    { layer: "arm", parent: "torso", a: img(armDown), b: img(armRight) },
  ];
  const sol = solveParts(parts);
  const out = inbetweens(parts, sol, [0.25, 0.5, 0.75]);
  const arms = out.get("arm");
  assert.equal(arms.length, 3);
  for (const [i, a] of arms.entries()) {
    const s = silhouette(a, i);
    assert.ok(Math.abs(s.area - 14) <= 4, `frame ${i}: area ${s.area}`);
    // The joint: some arm pixel touches the torso's right edge (x 12, rows 4-11).
    let touches = false;
    for (let y = 3; y <= 12; y++) for (let x = 11; x <= 13; x++) if (a.data[(y * W + x) * 4 + 3] >= 128) touches = true;
    assert.ok(touches, `frame ${i}: the arm left the shoulder`);
    for (let p = 0; p < a.data.length; p += 4) if (a.data[p + 3]) assert.deepEqual([...a.data.subarray(p, p + 3)], RED);
  }
  // The middle in-between points down and forward, about 45°: its far end is right of and below the shoulder.
  const mid = silhouette(arms[1], 1);
  assert.ok(mid.bounds[2] >= 15 && mid.bounds[3] >= 8, JSON.stringify(mid.bounds));
  // The torso didn't move.
  assert.deepEqual(silhouette(out.get("torso")[1], 1).bounds, [8, 4, 11, 11]);
});

test("a follower lags: early in the move it is closer to its key-A place than a part without lag", () => {
  const parts = [
    { layer: "a", a: img(rect(2, 10, 3, 3)), b: img(rect(16, 10, 3, 3)) },
    { layer: "hair", lag: 2, a: img(rect(2, 4, 3, 3), GREEN), b: img(rect(16, 4, 3, 3), GREEN) },
  ];
  const out = inbetweens(parts, solveParts(parts), [0.4], { lagStep: 1 / 4, easing: "linear" });
  const lead = silhouette(out.get("a")[0], 0).bounds[0], late = silhouette(out.get("hair")[0], 0).bounds[0];
  assert.ok(late < lead, `hair ${late} vs lead ${lead}`);
});

test("inbetween tool: fills the gaps between the clip's keys in one undo step, keys untouched (#110)", async () => {
  const cel = (pts, c) => ({ x: 0, y: 0, ...img(pts, c) });
  const fake = fakeDocument({ width: W, height: W, frames: 5, tags: [{ name: "wave", from: 1, to: 5 }],
    layers: [
      { name: "arm", frames: [cel(armDown), undefined, undefined, undefined, cel(armRight)] },
      { name: "torso", frames: [cel(torso, BLUE), cel(torso, BLUE), cel(torso, BLUE), cel(torso, BLUE), cel(torso, BLUE)] },
    ] });
  await runTool(findTool("motion_clip"), { action: "rig", character: "Kid", parts: [{ layer: "torso" }, { layer: "arm" }] }, fake);
  await runTool(findTool("motion_clip"), { action: "plan", tag: "wave", kind: "action", character: "Kid", keys: [1, 5] }, fake);
  const early = await runTool(findTool("inbetween"), { tag: "wave" }, fake);
  assert.match(early.content[0].text, /keys stage/);
  await runTool(findTool("motion_clip"), { action: "advance", tag: "wave" }, fake);
  const r = await runTool(findTool("inbetween"), { tag: "wave" }, fake);
  const t = r.content[0].text;
  assert.match(t, /Made 3 in-between frame\(s\) of "wave" for 2 part\(s\), ease-in-out; keys untouched/);
  assert.match(t, /frames 2, 3, 4 between keys 1 and 5: torso turns 0° \(fit 1\); arm turns -(8[89]|9[0-2])° about 1[23](\.\d)?,[4-6]/);
  const st = (await fake.request("get_state")).result.activeSprite;
  const arm = st.layers.find((l) => l.name === "arm");
  assert.deepEqual(arm.celFrames, [1, 2, 3, 4, 5]);
  const done = await runTool(findTool("motion_clip"), { action: "done", tag: "wave" }, fake);
  assert.match(done.content[0].text, /Clip "wave" is done/);
});
