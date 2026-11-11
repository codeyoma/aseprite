// Smears (#105): motion from the centroid and block matching, the four looks (sweep, stretch, afterimage,
// multiples) as pure functions, and the smear tool on the fake document (one put_images request: one undo step;
// only colors of the art and the palette).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterimage, artRamp, blockMotion, bresenham, centroid, darkerOf, edgeColor, fieldAt, fieldSpeed, ghostsAlong,
  motionVector, multiples, stretch, sweep,
} from "../dist/sprite_fx/smear.js";
import { findTool, runTool } from "../dist/tools.js";
import { documentOf } from "../dist/document.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const img = (w, h, r, c) => ({ width: w, height: h, data: rect(w, h, r, c) });
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const lit = (im) => { let n = 0; for (let i = 3; i < im.data.length; i += 4) if (im.data[i]) n++; return n; };
const colors = (im) => {
  const s = new Set();
  for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3]) s.add(`${im.data[i]},${im.data[i + 1]},${im.data[i + 2]}`);
  return s;
};
const alphas = (im) => { const s = new Set(); for (let i = 3; i < im.data.length; i += 4) s.add(im.data[i]); return s; };
const box = (im) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (!im.data[(y * im.width + x) * 4 + 3]) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};
/** A two-tone block: a light body with a dark 1 px outline. */
function ball(w, h, x0, y0, x1, y1) {
  const d = rect(w, h, [x0, y0, x1, y1], [40, 20, 60]);
  const inner = rect(w, h, [x0 + 1, y0 + 1, x1 - 1, y1 - 1], [230, 120, 40]);
  for (let i = 0; i < d.length; i += 4) if (inner[i + 3]) d.set(inner.subarray(i, i + 4), i);
  return { width: w, height: h, data: d };
}

test("motion: the centroid difference, and Bresenham steps one pixel at a time", () => {
  const a = img(32, 16, [2, 4, 7, 9], [200, 0, 0]), b = img(32, 16, [12, 6, 17, 11], [200, 0, 0]);
  assert.deepEqual(centroid(a), { x: 5, y: 7 });
  assert.deepEqual(motionVector(a, b), { x: 10, y: 2 });
  assert.equal(motionVector(a, img(32, 16, [0, 0, -1, -1], [0, 0, 0])), undefined, "an empty frame has no motion");
  const line = bresenham(5, -2);
  assert.deepEqual(line[0], { x: 0, y: 0 });
  assert.deepEqual(line.at(-1), { x: 5, y: -2 });
  assert.equal(line.length, 6);
  for (let i = 1; i < line.length; i++) assert.ok(Math.abs(line[i].x - line[i - 1].x) <= 1 && Math.abs(line[i].y - line[i - 1].y) <= 1);
});

test("block matching finds a part that moves while the rest stays", () => {
  // A still body (left) and an arm (right) that moves 3 px down between the frames.
  const W = 32, H = 24;
  const prev = img(W, H, [2, 8, 9, 15], [60, 60, 200]), cur = img(W, H, [2, 8, 9, 15], [60, 60, 200]);
  for (const [im, dy] of [[prev, 0], [cur, 3]]) {
    const arm = rect(W, H, [18, 4 + dy, 25, 9 + dy], [220, 200, 40]);
    // Texture so the match is not ambiguous.
    for (let i = 0; i < arm.length; i += 4) if (arm[i + 3]) { im.data.set(arm.subarray(i, i + 4), i); if ((i / 4) % 3 === 0) im.data[i] = 120; }
  }
  const coarse = motionVector(prev, cur);
  const f = blockMotion(prev, cur, coarse, { radius: 4 });
  assert.deepEqual(fieldAt(f, 4, 10, coarse), { x: 0, y: 0 }, "the body block stays");
  assert.deepEqual(fieldAt(f, 21, 9, coarse), { x: 0, y: 3 }, "the arm block moved down 3");
  assert.ok(fieldSpeed(f) >= 3);
  assert.deepEqual(blockMotion(prev, cur, coarse, { radius: 4 }), f, "deterministic");
});

test("sweep: a trail back along the motion, under the art, tapered, in the art's colors only", () => {
  const cur = ball(48, 24, 30, 6, 39, 15);
  const out = sweep(cur, { x: 16, y: 0 });
  const b = box(out);
  assert.equal(b.x + b.w, 40, "the head stays");
  assert.ok(b.x <= 16, `the trail reaches back (x ${b.x})`);
  for (const c of colors(out)) assert.ok(colors(cur).has(c), c);
  assert.deepEqual([...alphas(out)].sort((a, b) => a - b), [0, 255], "no partial alpha");
  // The art itself is drawn on top unchanged.
  for (let i = 0; i < cur.data.length; i += 4) if (cur.data[i + 3]) assert.deepEqual([...out.data.subarray(i, i + 4)], [...cur.data.subarray(i, i + 4)]);
  // Tapered: the column near the tail is shorter than the body.
  const colH = (x) => { let n = 0; for (let y = 0; y < 24; y++) if (out.data[(y * 48 + x) * 4 + 3]) n++; return n; };
  assert.ok(colH(b.x + 1) < colH(34), `tail ${colH(b.x + 1)} vs body ${colH(34)}`);
  const plain = sweep(cur, { x: 16, y: 0 }, { taper: 0, thin: false, fill: "edge" });
  assert.deepEqual([...colors(plain)].sort(), [...colors(cur)].sort(), "edge fill adds only the outline color");
  assert.ok(lit(plain) > lit(out), "no taper, no thinning: a fuller trail");
  assert.deepEqual(edgeColor(cur), { r: 40, g: 20, b: 60, a: 255 });
  assert.deepEqual(artRamp(cur).map((c) => c.r), [230, 40], "lightest first");
});

test("stretch: longer along the motion, narrower across, about the same area, leading edge in place", () => {
  const cur = img(64, 32, [40, 10, 49, 19], [10, 160, 90]);
  const out = stretch(cur, { x: 10, y: 0 });
  const b = box(out);
  assert.equal(b.x + b.w, 50, "the front stays");
  assert.ok(b.w >= 18 && b.h <= 6, JSON.stringify(b));
  assert.ok(Math.abs(lit(out) - lit(cur)) / lit(cur) < 0.25, `area ${lit(out)} vs ${lit(cur)}`);
  assert.deepEqual([...colors(out)], ["10,160,90"]);
});

test("afterimage: ghosts one palette step darker each, checker-dithered; multiples: sharp copies", () => {
  const palette = [[250, 200, 120], [200, 100, 40], [120, 50, 20], [60, 20, 10]].map(([r, g, b]) => ({ r, g, b, a: 255 }));
  assert.deepEqual(darkerOf(palette[0], palette), palette[1]);
  assert.deepEqual(darkerOf(palette[3], palette), palette[3], "nothing darker: kept");
  const cur = img(48, 16, [36, 4, 43, 11], [250, 200, 120]);
  const ghosts = ghostsAlong(cur, { x: 24, y: 0 }, 3);
  assert.equal(ghosts.length, 3);
  assert.deepEqual(box(ghosts[2]), { x: 12, y: 4, w: 8, h: 8 });
  const out = afterimage(cur, ghosts, palette);
  const at = (x, y) => [...out.data.subarray((y * 48 + x) * 4, (y * 48 + x) * 4 + 3)].join(",");
  assert.ok(["200,100,40", ""].includes(at(28, 6)) || at(29, 6) === "200,100,40", "the newest ghost is one step darker");
  assert.ok(colors(out).has("120,50,20") && colors(out).has("60,20,10"), "older ghosts darker still");
  let holes = 0; for (let x = 28; x < 36; x++) if (!out.data[(6 * 48 + x) * 4 + 3]) holes++;
  assert.equal(holes, 4, "a ghost row is half checkered");
  const many = multiples(cur, { x: 24, y: 0 }, 3);
  assert.equal(lit(many), 4 * 64, "three full copies and the art");
  assert.deepEqual([...colors(many)], ["250,200,120"]);
});

function sprite() {
  // Hero dashes right: slow, then 12 px, then 12 px, then stops.
  const at = (x) => ball(64, 32, x, 10, x + 7, 19).data;
  return fakeDocument({
    width: 64, height: 32, durations: [100, 100, 100, 100], layer: "Hero", palette: ["#000000", "#ffffff", "#201030", "#e67828", "#a05018"],
    layers: [
      { name: "BG", frames: Array.from({ length: 4 }, () => rect(64, 32, [0, 28, 63, 31], [20, 20, 20])) },
      { name: "Hero", frames: [at(4), at(5), at(17), at(29)] },
    ],
    tags: [{ name: "dash", from: 1, to: 4 }],
  });
}
const WRITES = new Set(["put_image", "put_images", "execute_lua", "apply_timeline_text"]);
const srcColors = new Set(["40,20,60", "230,120,40", "0,0,0", "255,255,255", "32,16,48", "230,120,40", "160,80,24"]);

test("smear over a tag smears only the fast frames, in one request, with the art's and palette's colors", async () => {
  for (const mode of ["sweep", "stretch", "afterimage", "multiples"]) {
    const fake = sprite();
    const r = await runTool(findTool("smear"), { mode, tag: "dash" }, fake);
    assert.ok(!r.isError, `${mode}: ${textOf(r)}`);
    assert.deepEqual(fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method), ["put_images"], mode);
    const call = fake.calls.find((c) => c.method === "put_images");
    const st = await documentOf(fake).info();
    assert.equal(st.durations.length, 4, "no frames added");
    const hero = st.layers.find((l) => l.name === "Hero"), smear = st.layers.find((l) => l.name === "AI: smear Hero");
    assert.ok(hero && smear && !hero.visible && smear.visible, mode);
    assert.match(textOf(r), /smeared frames 3 \(12, 0\), 4 \(12, 0\)/, mode);
    assert.match(textOf(r), /1: no motion; 2: 1\.0 px/, "frame 1 starts the tag; frame 2 is slow");
    for (const f of [1, 2, 3, 4]) {
      const px = await documentOf(fake).pixels(smear.id, f);
      for (const c of colors(px)) assert.ok(srcColors.has(c), `${mode} frame ${f}: ${c}`);
    }
    assert.equal(call.params.palette, undefined, "no colors added");
    assert.ok(r.content.some((c) => c.type === "image"));
  }
});

test("smear loop: true measures a tag's first frame from its last", async () => {
  const r = await runTool(findTool("smear"), { mode: "multiples", tag: "dash", loop: true, preview: true }, sprite());
  assert.match(textOf(r), /frames 1 \(-25, 0\), 3 \(12, 0\), 4 \(12, 0\)/);
});

test("smear insert_after puts one smear frame between two frames; preview and errors change nothing", async () => {
  const fake = sprite();
  const p = await runTool(findTool("smear"), { mode: "sweep", insert_after: 2, preview: true }, fake);
  assert.ok(!p.isError, textOf(p));
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);
  const r = await runTool(findTool("smear"), { mode: "sweep", insert_after: 2, duration_ms: 40 }, fake);
  assert.ok(!r.isError, textOf(r));
  const st = await documentOf(fake).info();
  assert.equal(st.durations.length, 5);
  assert.equal(st.durations[2], 40);
  assert.equal(st.tags[0].to, 5, "the tag grew over the insert");
  assert.match(textOf(r), /inserted a 40 ms smear frame after frame 2 \(frame 3, motion \(12, 0\)\)/);

  const slow = sprite();
  const none = await runTool(findTool("smear"), { mode: "sweep", frames: [2], min_px: 3 }, slow);
  assert.ok(none.isError && /Nothing moves fast enough/.test(textOf(none)), textOf(none));
  const one = await runTool(findTool("smear"), { mode: "multiples", frames: 2, vector: { x: 8, y: -4 } }, slow);
  assert.ok(!one.isError, textOf(one));
  assert.match(textOf(one), /smeared frames 2 \(8, -4\)/);
  assert.ok((await runTool(findTool("smear"), { mode: "sweep", insert_after: 4 }, sprite())).isError, "no frame after the last");
  assert.ok((await runTool(findTool("smear"), { mode: "sweep", tag: "nope" }, sprite())).isError);
});
