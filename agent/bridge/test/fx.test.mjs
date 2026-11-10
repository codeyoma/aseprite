// Pixel FX engine (#68): the vendored pixelfx core behind renderFx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderFx } from "../dist/fx/index.js";
import { Painter, createFrame, composite, createFx, hex } from "../dist/fx/vendor/core/index.js";
import * as hitSpark from "../dist/fx/vendor/effects/impacts/hit-spark.js";
import * as plasmaBall from "../dist/fx/vendor/effects/lightning/plasma-ball.js";
import * as poisonCloud from "../dist/fx/vendor/effects/nature/poison-cloud.js";

const hashOf = (images) => {
  const h = createHash("sha256");
  for (const im of images) h.update(im.data);
  return h.digest("hex");
};
const same = (a, b) => Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const lit = (im) => {
  let n = 0;
  for (let i = 3; i < im.data.length; i += 4) if (im.data[i]) n++;
  return n;
};

test("renderFx: canvas, origin, duration and frame counts come from the effect", () => {
  const r = renderFx(hitSpark, {}, { fps: 30, seed: 1 });
  assert.equal(r.width, 136);
  assert.equal(r.height, 80);
  assert.deepEqual(r.origin, { x: 44, y: 64 });
  assert.equal(r.durationMs, 500);
  assert.equal(r.loop, false);
  assert.equal(r.frames.length, 16); // one-shot: t = 0 .. duration
  assert.equal(r.glow.length, 16);
  assert.equal(r.frames[0].data.length, 136 * 80 * 4);
  const loop = renderFx(plasmaBall, {}, { fps: 30, seed: 1 });
  assert.equal(loop.loop, true);
  assert.equal(loop.frames.length, 90); // loop: t = 0 .. duration - 1 / fps
});

test("the same seed renders identical frames; another seed does not", () => {
  for (const fx of [hitSpark, plasmaBall]) {
    const a = renderFx(fx, {}, { fps: 30, seed: 7 });
    const b = renderFx(fx, {}, { fps: 30, seed: 7 });
    const c = renderFx(fx, {}, { fps: 30, seed: 8 });
    assert.equal(hashOf(a.frames), hashOf(b.frames));
    assert.equal(hashOf(a.glow), hashOf(b.glow));
    assert.notEqual(hashOf(a.frames), hashOf(c.frames));
  }
});

test("30 fps and 60 fps agree at shared times (sims step at 120 Hz either way)", () => {
  for (const fx of [hitSpark, plasmaBall, poisonCloud]) {
    const a = renderFx(fx, {}, { fps: 30, seed: 3 });
    const b = renderFx(fx, {}, { fps: 60, seed: 3 });
    assert.ok(a.frames.some((f) => lit(f) > 0), `${fx.meta.name} draws something`);
    a.frames.forEach((f, i) => {
      assert.ok(same(f, b.frames[2 * i]), `${fx.meta.name} frame ${i} at 30 fps vs ${2 * i} at 60 fps`);
      assert.ok(same(a.glow[i], b.glow[2 * i]), `${fx.meta.name} glow ${i}`);
    });
  }
});

test("a loop has no seam: the frame at t = duration is the frame at 0", () => {
  for (const fx of [plasmaBall, poisonCloud]) {
    const n = Math.round(fx.meta.duration * 30);
    const r = renderFx(fx, {}, { fps: 30, seed: 2, frames: n + 1 });
    assert.ok(same(r.frames[n], r.frames[0]), `${fx.meta.name} wraps`);
    assert.ok(same(r.glow[n], r.glow[0]), `${fx.meta.name} glow wraps`);
    assert.ok(!same(r.frames[n >> 1], r.frames[0]), `${fx.meta.name} moves`);
  }
});

test("a one-shot ends empty", () => {
  const r = renderFx(hitSpark, {}, { fps: 30, seed: 4 });
  assert.ok(lit(r.frames[2]) > 0);
  const last = r.frames.length - 1;
  assert.equal(lit(r.frames[last]), 0);
  assert.equal(lit(r.glow[last]), 0);
});

test("palette snapping: every opaque pixel takes a sprite palette color", () => {
  const palette = [
    { r: 0, g: 0, b: 0, a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    { r: 255, g: 128, b: 0, a: 255 },
  ];
  const r = renderFx(hitSpark, {}, { fps: 30, seed: 4, palette });
  const allowed = new Set(palette.map((c) => `${c.r},${c.g},${c.b}`));
  let checked = 0;
  for (const f of r.frames)
    for (let i = 0; i < f.data.length; i += 4)
      if (f.data[i + 3] >= 128) {
        assert.ok(allowed.has(`${f.data[i]},${f.data[i + 1]},${f.data[i + 2]}`));
        checked++;
      }
  assert.ok(checked > 0);
});

test("Bayer fade: alpha a draws the 4x4 cells whose threshold is below a", () => {
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const red = hex("#ff0000");
  for (const a of [0, 0.25, 0.5, 0.75, 1]) {
    const f = createFrame(4, 4);
    const p = new Painter(f);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) p.dot(x, y, red, a);
    const drawn = [...f.color].map((c) => (c ? 1 : 0));
    const expected = BAYER.map((v) => (a >= 1 || a > (v + 0.5) / 16 ? 1 : 0));
    assert.deepEqual(drawn, expected, `alpha ${a}`);
  }
  // a 50% fade is an even checker: exactly half the cells
  const f = createFrame(8, 8);
  const p = new Painter(f);
  p.rect(0, 0, 8, 8, red, 0.5);
  assert.equal([...f.color].filter(Boolean).length, 32);
});

test("light over transparency becomes color with alpha; over color it adds", () => {
  const f = createFrame(2, 1);
  const p = new Painter(f);
  p.add(0, 0, hex("#644020"), 1); // light (100, 64, 32) on nothing
  p.put(1, 0, hex("#102030")); // an opaque pixel
  p.add(1, 0, hex("#644020"), 1);
  const out = composite(f, new Uint8Array(8), null);
  // alpha is the brightest channel; the color is the light divided by it
  assert.deepEqual([...out.subarray(0, 4)], [255, 163, 81, 100]);
  // opaque: plain additive
  assert.deepEqual([...out.subarray(4, 8)], [0x10 + 100, 0x20 + 64, 0x30 + 32, 255]);
  // renderFx returns the light alone as glow, and frames bake it in
  const r = renderFx(hitSpark, {}, { fps: 30, seed: 4 });
  const g = r.glow[0], fr = r.frames[0];
  let onlyLight = 0;
  for (let i = 0; i < g.data.length; i += 4)
    if (g.data[i + 3] && fr.data[i + 3] > 0 && fr.data[i + 3] < 255) onlyLight++;
  assert.ok(onlyLight > 0, "glow over empty pixels shows as translucent color");
});

test("flip and rotate move whole cells", () => {
  const shape = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2], [3, -2]];
  const draw = (flip, angle) => {
    const f = createFrame(16, 16);
    const p = new Painter(f).place(8, 8, flip, angle);
    for (const [x, y] of shape) p.px(x, y, hex("#ffffff"));
    const set = new Set();
    f.color.forEach((c, i) => c && set.add(`${i % 16},${Math.floor(i / 16)}`));
    return set;
  };
  const key = (x, y) => `${x},${y}`;
  // local cell (x, y) covers [x, x+1) x [y, y+1) around the origin (8, 8)
  assert.deepEqual(draw(false, 0), new Set(shape.map(([x, y]) => key(8 + x, 8 + y))));
  assert.deepEqual(draw(true, 0), new Set(shape.map(([x, y]) => key(8 - x - 1, 8 + y))));
  assert.deepEqual(draw(false, Math.PI / 2), new Set(shape.map(([x, y]) => key(8 - y - 1, 8 + x))));
  assert.deepEqual(draw(false, Math.PI), new Set(shape.map(([x, y]) => key(8 - x - 1, 8 - y - 1))));
  // filled shapes mirror exactly too (dithered fades do not: the Bayer grid stays put on screen)
  const shapes = (flip) => {
    const f = createFrame(32, 32);
    const p = new Painter(f).place(16, 16, flip, 0);
    p.circle(-5, -3, 4.5, hex("#ff0000"));
    p.beam(-2, 6, 11, -9, 3, hex("#00ff00"));
    p.arc(3, 2, 9, 3, 0.2, 2.4, hex("#0000ff"));
    return f.color;
  };
  const plain = shapes(false), flipped = shapes(true);
  let mismatch = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) if (plain[y * 32 + x] !== flipped[y * 32 + (31 - x)]) mismatch++;
  assert.equal(mismatch, 0);
  assert.ok(plain.some(Boolean));
});

test("unsupported parts fail loudly: text and actor effects", () => {
  const p = new Painter(createFrame(4, 4));
  assert.throws(() => p.text("HI", 0, 0, hex("#fff")), /text not supported/);
  assert.throws(() => createFx({ meta: { size: [4, 4], origin: [0, 0], actor: 2 }, draw() {} }), /needs an actor/);
});
