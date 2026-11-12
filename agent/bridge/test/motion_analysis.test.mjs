// Motion analysis (#111): fixtures with deliberate defects, each found by its metric.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTracks, flickerOf, silhouette } from "../dist/motion_analysis.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

const W = 16;
/** An image with the given points in a color (default red). */
const img = (pts, color = [200, 0, 0]) => {
  const d = new Uint8Array(W * W * 4);
  for (const [x, y, c] of pts) d.set([...(c ?? color), 255], (y * W + x) * 4);
  return { width: W, height: W, data: d };
};
const box = (x0, y0, w, h, color) => {
  const pts = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pts.push([x, y, color]);
  return pts;
};
const tracksOf = (images, part = "") => [{ part, frames: images.map((im, i) => silhouette(im, i + 1)) }];
const run = (images, o = {}, parts = []) => {
  const frames = images.map((_, i) => i + 1);
  return analyzeTracks([...tracksOf(images), ...parts], images, { frames, durations: o.durations ?? frames.map(() => 100), loop: o.loop ?? false, ...o });
};
const metric = (r, m) => r.findings.filter((f) => f.metric === m);

test("silhouette: area, bounds, centroid, top and feet", () => {
  const s = silhouette(img(box(2, 3, 4, 2)), 7);
  assert.deepEqual(s, { frame: 7, area: 8, bounds: [2, 3, 5, 4], centroid: [3.5, 3.5], top: [3.5, 3], feet: [3.5, 4] });
  assert.deepEqual(silhouette(img([]), 1), { frame: 1, area: 0 });
});

test("volume: a part that grows is an error; the figure alone only warns", () => {
  const arm = [img(box(2, 2, 2, 4)), img(box(3, 2, 2, 4)), img(box(4, 2, 2, 7)), img(box(5, 2, 2, 4))];
  const r = run(arm, {}, tracksOf(arm, "near arm"));
  const v = metric(r, "volume");
  assert.equal(v.find((f) => f.part === "near arm").severity, "error");
  assert.match(v.find((f) => f.part === "near arm").message, /"near arm" is 75% bigger in frame 3 than in most frames \(8 px\)/);
  assert.equal(v.find((f) => f.part === "").severity, "warning");
  assert.equal(r.metrics.volume.find((x) => x.part === "near arm").drift, 0.75);
});

test("flicker: colors that change and change back inside the shape boil; a passing part does not", () => {
  const blue = [0, 0, 200];
  const still = box(4, 4, 6, 6);
  // Scattered single pixels change and change back: boiling.
  const specks = [[4, 4], [7, 5], [9, 7], [5, 9]];
  const boil = [img(still), img(still.map(([x, y]) => (specks.some((p) => p[0] === x && p[1] === y) ? [x, y, blue] : [x, y]))), img(still)];
  const r = run(boil, { loop: false });
  assert.equal(metric(r, "flicker")[0].severity, "error");
  assert.deepEqual(metric(r, "flicker")[0].frames, [2]);
  assert.deepEqual(flickerOf(boil, [1, 2, 3], false), [{ frame: 2, pixels: 4 }]);
  // A block of another color passing over the shape (an arm across the body) is motion.
  const arm = [img(still), img(still.map(([x, y]) => (y >= 6 && y <= 7 ? [x, y, blue] : [x, y]))), img(still)];
  assert.equal(metric(run(arm), "flicker").length, 0);
  const passing = [img(box(0, 4, 3, 3)), img(box(5, 4, 3, 3)), img(box(10, 4, 3, 3))];
  assert.equal(metric(run(passing), "flicker").length, 0);
});

test("spacing: a pop is a warning, even spacing of a part is a note", () => {
  const pop = [0, 1, 2, 9, 10].map((x) => img(box(x, 4, 3, 3)));
  const r = run(pop, {}, tracksOf(pop, "ball"));
  assert.match(metric(r, "spacing").find((f) => f.severity === "warning").message, /jumps into frame 4 \(7 px against 1 px a frame\)/);
  const even = [0, 2, 4, 6, 8].map((x) => img(box(x, 4, 3, 3)));
  const e = run(even, {}, tracksOf(even, "ball"));
  assert.match(metric(e, "spacing").find((f) => f.part === "ball").message, /moves the same 2 px every frame/);
  assert.equal(e.metrics.spacing.find((s) => s.part === "ball").evenness, 1);
});

test("arcs: a limb on a straight line is a note; a bent path is not", () => {
  const straight = [0, 2, 4, 6, 8].map((x) => img(box(x, 4, 2, 2)));
  assert.match(metric(run(straight, {}, tracksOf(straight, "hand")), "arc")[0].message, /"hand" travels 8 px on a straight line/);
  const bent = [[0, 8], [2, 5], [4, 4], [6, 5], [8, 8]].map(([x, y]) => img(box(x, y, 2, 2)));
  const b = run(bent, {}, tracksOf(bent, "hand"));
  assert.equal(metric(b, "arc").length, 0);
  assert.equal(b.metrics.arcs[0].bend, 4);
});

test("ground and foot slide: feet leaving the ground row, a planted foot sliding forward", () => {
  const legs = (x, lift) => img(box(x, 6, 3, 8 - lift));
  const frames = [legs(4, 0), legs(4, 1), legs(4, 0), legs(4, 0)];
  const g = run(frames, { contacts: [1, 3], facing: "right" });
  assert.match(metric(g, "ground")[0].message, /leave the ground row 13 in frame 2 \(row 12\)/);
  const slide = [legs(4, 0), legs(7, 0), legs(4, 0), legs(4, 0)];
  assert.match(metric(run(slide, { contacts: [1], facing: "right" }), "foot-slide")[0].message, /slides forward after contact frame 1/);
  assert.equal(metric(run(slide, { contacts: [1], facing: "left" }), "foot-slide").length, 0, "sliding back is fine when facing left");
});

test("seam, flat timing and a static animation", () => {
  const loop = [0, 1, 2, 3, 11].map((x) => img(box(x, 4, 3, 3)));
  assert.match(metric(run(loop, { loop: true }), "seam")[0].message, /jumps 11 px from the last frame back to the first/);
  const four = [0, 1, 2, 3].map((x) => img(box(x, 4, 3, 3)));
  assert.match(metric(run(four), "timing")[0].message, /Every frame lasts 100 ms/);
  assert.equal(metric(run(four, { durations: [200, 80, 80, 200] }), "timing").length, 0);
  const same = [1, 2, 3].map(() => img(box(4, 4, 3, 3)));
  assert.equal(metric(run(same), "static")[0].severity, "error");
});

test("motion_check and the trails view on a clip: rig parts are tracked, errors block motion_clip done (#111)", async () => {
  const cel = (pts) => ({ x: 0, y: 0, ...img(pts) });
  const arm = [box(2, 2, 2, 4), box(4, 2, 2, 4), box(6, 2, 2, 9), box(8, 2, 2, 4)];
  const fake = fakeDocument({ width: W, height: W, frames: 4, tags: [{ name: "swing", from: 1, to: 4 }],
    layers: [{ name: "arm", frames: arm.map(cel) }] });
  await runTool(findTool("motion_clip"), { action: "rig", character: "Hero", parts: [{ layer: "arm" }] }, fake);
  await runTool(findTool("motion_clip"), { action: "plan", tag: "swing", kind: "action", character: "Hero", keys: [1, 2, 3, 4] }, fake);
  await runTool(findTool("motion_clip"), { action: "advance", tag: "swing" }, fake);
  const check = await runTool(findTool("motion_check"), { tag: "swing" }, fake);
  assert.equal(check.isError, true);
  assert.match(check.content[0].text, /^MOTION CHECK "swing": 1 error/);
  assert.match(check.content[0].text, /error: \[volume\] "arm" is 125% bigger in frame 3/);
  const done = await runTool(findTool("motion_clip"), { action: "done", tag: "swing" }, fake);
  assert.match(done.content[0].text, /^Not done: motion_check finds "arm" is 125% bigger/);
  const trails = await runTool(findTool("snapshot"), { view: "trails", tag: "swing" }, fake);
  assert.ok(trails.content.some((c) => c.type === "image"));
  assert.match(trails.content.find((c) => c.type === "text").text, /Trails of "swing" \(frames 1-4\).*white = the whole figure, amber = arm/s);
});
