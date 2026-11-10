// Animation helpers (#42): RotSprite transforms, arcs, squash and stretch, smears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { along, bounds, ease, scale2x, smear, squashStretch, transform } from "../dist/animation.js";
import { findTool, runTool } from "../dist/tools.js";

function sword(W = 40) {
  const d = new Uint8Array(W * W * 4);
  const put = (x, y, c) => d.set([...c, 255], (y * W + x) * 4);
  for (let y = 6; y < 22; y++) { put(19, y, [24, 20, 37]); put(20, y, [200, 210, 230]); put(21, y, [24, 20, 37]); }
  for (let x = 16; x < 25; x++) put(x, 22, [171, 82, 54]);
  for (let y = 23; y < 28; y++) put(20, y, [120, 60, 40]);
  return { width: W, height: W, data: d };
}
const colors = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(img.data.slice(i, i + 3).join()); return s; };
const count = (img) => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++; return n; };

test("scale2x keeps colors and doubles size", () => {
  const s = scale2x(sword());
  assert.equal(s.width, 80);
  assert.deepEqual(colors(s), colors(sword()));
});

test("rotation and scaling add no colors and keep the shape's size", () => {
  const img = sword();
  for (const angle of [15, 30, 45, 90, 180]) {
    const r = transform(img, { angle, px: 20, py: 17 });
    for (const c of colors(r)) assert.ok(colors(img).has(c), `angle ${angle}: new color ${c}`);
    assert.ok(Math.abs(count(r) - count(img)) / count(img) < 0.2, `angle ${angle}: ${count(r)} vs ${count(img)} px`);
  }
  const turned = bounds(transform(img, { angle: 90, px: 20, py: 17 }));
  assert.ok(turned.w > turned.h, "90 degrees lies the sword on its side");
  assert.deepEqual(colors(transform(img, { dx: 3 })), colors(img));
});

test("along: eased, arced path that ends at the target", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.25) < 0.25, "ease-in-out starts slow");
  const end = along({ dx: 10, angle: 90 }, 1, 6);
  assert.deepEqual([end.dx, end.dy, end.angle], [10, 0, 90]);
  assert.equal(along({ dx: 10 }, 0.5, 6, "linear").dy, -6, "highest at the middle");
});

test("squash keeps the feet on the ground; stretch makes it taller", () => {
  const img = sword(), b = bounds(img);
  const sq = bounds(squashStretch(img, -0.3)), st = bounds(squashStretch(img, 0.3));
  assert.equal(sq.y + sq.h, b.y + b.h);
  assert.equal(st.y + st.h, b.y + b.h);
  assert.ok(sq.h < b.h && sq.w > b.w && st.h > b.h);
});

test("a smear covers the path between two poses", () => {
  const a = sword(), b = transform(a, { dx: 12 });
  const s = smear(a, b);
  const sb = bounds(s), ab = bounds(a), bb = bounds(b);
  assert.equal(sb.x, ab.x);
  assert.equal(sb.x + sb.w, bb.x + bb.w);
  for (const c of colors(s)) assert.ok(colors(a).has(c));
});

test("transform_layer writes frames after from_frame", async () => {
  const img = sword();
  const calls = [];
  const fake = {
    async request(m, p) {
      calls.push({ m, p });
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 40, height: 40, frames: Array(6).fill(100).map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "Sword" }], tags: [], palette: { colors: [] } } } };
      if (m === "snapshot") return { result: { width: 40, height: 40 }, binary: Buffer.from(img.data) };
      return { result: {} };
    },
  };
  const r = await runTool(findTool("transform_layer"), { layer: "Sword", from_frame: 1, to_frame: 5, move: { angle: 90, pivot_x: 20, pivot_y: 27 }, arc: 3 }, fake);
  const puts = calls.filter((c) => c.m === "put_image");
  assert.deepEqual(puts.map((p) => p.p.frame), [2, 3, 4, 5]);
  assert.match(r.content[0].text, /frames 2-5 \(4 steps, ease-in-out, arc 3px\)/);
  const bad = await runTool(findTool("transform_layer"), { layer: "Sword", from_frame: 1, to_frame: 9, move: { dx: 1 } }, fake);
  assert.equal(bad.isError, true);
});

test("sub-pixel shift: edges change shade, the drawing doesn't jump", async () => {
  const { subpixelShift, imageColors } = await import("../dist/animation.js");
  const W = 8, H = 3, d = new Uint8Array(W * H * 4);
  // A dark background row with a bright 2 px block at x 2-3.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(x === 2 || x === 3 ? [240, 220, 120, 255] : [30, 30, 60, 255], (y * W + x) * 4);
  const ramp = [{ r: 30, g: 30, b: 60, a: 255 }, { r: 135, g: 125, b: 90, a: 255 }, { r: 240, g: 220, b: 120, a: 255 }];
  const half = subpixelShift({ width: W, height: H, data: d }, 0.5, 0, ramp);
  const row = (img) => [...Array(W)].map((_, x) => img.data[x * 4]);
  // Half a pixel right: x 2 and 4 take the middle shade, x 3 stays bright.
  assert.deepEqual(row(half), [30, 30, 135, 240, 135, 30, 30, 30]);
  const whole = subpixelShift({ width: W, height: H, data: d }, 1, 0, ramp);
  assert.deepEqual(row(whole), [0, 30, 30, 240, 240, 30, 30, 30], "nothing moves into column 0");
  assert.equal(imageColors({ width: W, height: H, data: d }).length, 2);
});

test("subpixel_move writes the in-between frames", async () => {
  const { fakeDocument } = await import("./helpers/fake_document.mjs");
  const { findTool, runTool } = await import("../dist/tools.js");
  const W = 8, d = new Uint8Array(W * W * 4);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) d.set([240, 220, 120, 255], (y * W + x) * 4);
  const fake = fakeDocument({ width: W, height: W, frames: 3, layers: [{ name: "Blob", frames: [d] }], palette: ["#78704c", "#f0dc78"] });
  const r = await runTool(findTool("subpixel_move"), { layer: "Blob", from_frame: 1, to_frame: 3, dy: 1 }, fake);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /steps of 0\.50 px/);
  assert.ok(fake.cel("Blob", 2) && fake.cel("Blob", 3));
  assert.equal(fake.cel("Blob", 3)[(6 * W + 3) * 4 + 3], 255, "a whole pixel down by frame 3");
});
