// Juice (#104): curves, the pixel-safe warp, the per-effect plan, and the juice tool on the fake document
// (one put_images request: one undo step; the source hidden under its copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bounce, ease, EASES, spring } from "../dist/sprite_fx/curves.js";
import { juicePlan, JUICE_EFFECTS } from "../dist/sprite_fx/juice.js";
import { pivotOf, scale2x, upscale8, warp } from "../dist/sprite_fx/raster.js";
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
const box = (im) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (!im.data[(y * im.width + x) * 4 + 3]) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

test("curves: easings hit their ends, the spring starts at 1 and settles, the bounce lands at the end", () => {
  for (const e of EASES) {
    assert.ok(Math.abs(ease(e, 0)) < 1e-9, `${e}(0)`);
    assert.ok(Math.abs(ease(e, 1) - 1) < 1e-9, `${e}(1)`);
  }
  assert.equal(spring(0), 1);
  assert.ok(Math.abs(spring(1, 2, 0.4)) < 0.05, "settled by t = 1");
  assert.ok(spring(0.25, 2, 0.1) < 0, "an underdamped spring overshoots");
  assert.ok(spring(0.5, 2, 1.5) > 0, "an overdamped one does not");
  assert.equal(bounce(0).h, 1);
  assert.ok(bounce(1).h < 1e-9 && bounce(1).landing);
});

test("scale2x keeps the palette and rounds a diagonal; warp by whole pixels just moves", () => {
  const sq = img(4, 4, [0, 0, 1, 1], [200, 0, 0]);
  const up = scale2x(sq);
  assert.equal(up.width, 8);
  assert.deepEqual([...colors(up)], ["200,0,0"]);
  const moved = warp(sq, { dx: 2, dy: 1 }, { x: 0, y: 0 });
  assert.deepEqual(box(moved), { x: 2, y: 1, w: 2, h: 2 });
});

test("warp: a 90-degree turn of a bar stands it up, with no new colors", () => {
  const bar = img(16, 16, [4, 7, 11, 8], [10, 120, 30]);
  const turned = warp(bar, { rot: Math.PI / 2 }, { x: 8, y: 8 }, upscale8(bar));
  const b = box(turned);
  assert.ok(b.h >= 7 && b.w <= 3, JSON.stringify(b));
  assert.deepEqual([...colors(turned)], ["10,120,30"]);
});

test("squash keeps the area near constant and the feet planted", () => {
  const man = img(32, 32, [12, 8, 19, 31], [90, 90, 200]);
  const { pivot, box: b } = pivotOf(man, "bottom");
  const [peak] = juicePlan("squash", 6, b, { amount: 0.4 });
  const out = warp(man, peak.warp, pivot, upscale8(man));
  const ob = box(out);
  assert.ok(ob.h < 24 && ob.w > 8, "flatter and wider");
  assert.equal(ob.y + ob.h, 32, "the bottom row stays");
  assert.ok(Math.abs(lit(out) - lit(man)) / lit(man) < 0.2, `area ${lit(out)} vs ${lit(man)}`);
});

test("every effect makes the asked number of frames", () => {
  for (const e of JUICE_EFFECTS) assert.equal(juicePlan(e, 5, { x: 0, y: 0, w: 8, h: 8 }).length, 5, e);
});

function sprite() {
  return fakeDocument({
    width: 32, height: 32, durations: [100, 100, 100], layer: "Hero",
    layers: [
      { name: "BG", frames: [rect(32, 32, [0, 0, 31, 31], [20, 20, 20]), rect(32, 32, [0, 0, 31, 31], [20, 20, 20]), rect(32, 32, [0, 0, 31, 31], [20, 20, 20])] },
      { name: "Hero", frames: [rect(32, 32, [12, 10, 19, 29], [200, 60, 60]), rect(32, 32, [13, 10, 20, 29], [200, 60, 60]), rect(32, 32, [14, 10, 21, 29], [200, 60, 60])] },
    ],
    tags: [{ name: "idle", from: 1, to: 3 }],
  });
}
const WRITES = new Set(["put_image", "put_images", "execute_lua", "apply_timeline_text"]);

test("juice inserts frames after the frame onto 'AI: juice Hero', hides Hero, copies it elsewhere: one request", async () => {
  const fake = sprite();
  const r = await runTool(findTool("juice"), { effect: "squash", frame: 2, frames: 4 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method), ["put_images"]);
  const st = await documentOf(fake).info();
  assert.equal(st.durations.length, 7);
  assert.deepEqual(st.durations.slice(2, 6), [50, 50, 50, 50]);
  const hero = st.layers.find((l) => l.name === "Hero"), juice = st.layers.find((l) => l.name === "AI: juice Hero");
  assert.ok(juice && hero && !hero.visible && juice.visible);
  assert.equal(st.tags[0].to, 7, "the tag grew over the insert");
  assert.ok(r.content.some((c) => c.type === "image"), "a contact sheet comes back");
  assert.match(textOf(r), /inserted 4 frames of 50 ms after frame 2 \(frames 3-6\)/);
});

test("juice over existing frames transforms each frame's own art; preview changes nothing", async () => {
  const fake = sprite();
  const p = await runTool(findTool("juice"), { effect: "shake", over: "all", px: 3, preview: true }, fake);
  assert.ok(!p.isError, textOf(p));
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);
  const r = await runTool(findTool("juice"), { effect: "wobble", over: "1-3" }, fake);
  assert.ok(!r.isError, textOf(r));
  const st = await documentOf(fake).info();
  assert.equal(st.durations.length, 3, "no frames added");
  assert.match(textOf(r), /transformed frames 1, 2, 3/);
});

test("flash adds its color to the palette in the same request; a missing layer fails", async () => {
  const fake = sprite();
  const r = await runTool(findTool("juice"), { effect: "flash", color: "#ffeeaa" }, fake);
  assert.ok(!r.isError, textOf(r));
  const call = fake.calls.find((c) => c.method === "put_images");
  assert.deepEqual(call.params.palette, ["#ffeeaa"]);
  const bad = await runTool(findTool("juice"), { effect: "spin", layer: "Nope" }, fake);
  assert.ok(bad.isError);
});
