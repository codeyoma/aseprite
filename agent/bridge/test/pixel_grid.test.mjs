// Pixel snap (#37): grid detection and resampling on generated fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGrid, resample, scaleBy, trim, upscale } from "../dist/pixel_grid.js";
import { findTool, runTool } from "../dist/tools.js";

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
/** A 24x24 sprite: a disc of random palette colors on transparency. */
function sprite(seed = 1, size = 24) {
  const rnd = rng(seed);
  const pal = [[29, 43, 83], [126, 37, 83], [0, 135, 81], [171, 82, 54], [255, 163, 0], [41, 173, 255]];
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 2.4) ** 2) d.set([...pal[Math.floor(rnd() * 6)], 255], (y * size + x) * 4);
  }
  return { width: size, height: size, data: d };
}
function noisy(img, amt) {
  const rnd = rng(7), d = new Uint8Array(img.data);
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, d[i + k] + Math.round((rnd() - 0.5) * 2 * amt)));
  return { ...img, data: d };
}
function soften(img) {
  const { width: w, height: h } = img, d = new Uint8Array(img.data);
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) for (let k = 0; k < 4; k++) d[(y * w + x) * 4 + k] = Math.round((img.data[(y * w + x) * 4 + k] * 3 + img.data[(y * w + x - 1) * 4 + k]) / 4);
  return { ...img, data: d };
}
/** Share of matching pixels after trimming both (colors within 20 per channel). */
function match(a, b) {
  const ta = trim(a), tb = trim(b);
  if (ta.width !== tb.width || ta.height !== tb.height) return 0;
  let ok = 0;
  for (let i = 0; i < ta.data.length; i += 4) {
    const same = (ta.data[i + 3] >= 128) === (tb.data[i + 3] >= 128) && [0, 1, 2].every((k) => Math.abs(ta.data[i + k] - tb.data[i + k]) < 20);
    if (same) ok++;
  }
  return ok / (ta.data.length / 4);
}

const base = sprite();

test("whole scales with offsets recover the original exactly", () => {
  for (const [s, px, py] of [[3, 0, 0], [4, 0, 0], [5, 2, 3], [6, 3, 5], [7, 1, 0], [8, 7, 2]]) {
    const up = upscale(base, s, px, py);
    const g = detectGrid(up);
    assert.equal(g.cellX, s, `x${s} cell`);
    assert.equal(match(resample(up, g), base), 1, `x${s} pixels`);
  }
});

test("odd scales, noise and soft edges recover at least 98%", () => {
  for (const f of [4.5, 5.5, 6.25, 7.3]) {
    const g = detectGrid(scaleBy(base, f, 1, 2));
    assert.ok(Math.abs(g.cellX - f) < 0.06, `x${f}: ${g.cellX}`);
  }
  for (const img of [noisy(upscale(base, 6), 12), soften(upscale(base, 6)), noisy(scaleBy(base, 5.5), 10)]) {
    const g = detectGrid(img);
    assert.ok(match(resample(img, g), base) >= 0.98, JSON.stringify(g));
  }
});

test("grain over large flat areas doesn't hide the grid", () => {
  // Big flat blobs: few real edges, noise everywhere.
  const W = 32, d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - 16, (y - 20) * 1.3);
    if (r < 11) d.set([...(r > 9.5 ? [24, 60, 40] : y < 16 ? [120, 220, 120] : [60, 170, 80]), 255], (y * W + x) * 4);
  }
  const slime = { width: W, height: W, data: d };
  const img = noisy(scaleBy(slime, 5.5, 3, 2), 10);
  const g = detectGrid(img);
  assert.ok(Math.abs(g.cellX - 5.5) < 0.06, JSON.stringify(g));
  assert.ok(match(resample(img, g), slime) >= 0.98);
});

test("native pixel art has no grid", () => {
  assert.equal(detectGrid(base).cellX, 1);
  assert.equal(detectGrid(sprite(3, 64)).cellX, 1);
});

test("a 1024 px image is analysed quickly", () => {
  const big = upscale(sprite(5, 64), 16);
  const t0 = Date.now();
  const g = detectGrid(big);
  assert.equal(g.cellX, 16);
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
});

test("fix_pixel_art opens the native sprite; detect_pixel_grid reports the grid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-"));
  const up = noisy(scaleBy(base, 5.5, 2, 1), 8);
  const png = new PNG({ width: up.width, height: up.height });
  png.data.set(up.data);
  writeFileSync(join(dir, "ai.png"), PNG.sync.write(png));
  const calls = [];
  const fake = { request: async (m, p) => { calls.push({ m, p }); return { result: { title: p.title ?? "x" } }; } };
  const d = await runTool(findTool("detect_pixel_grid"), { path: join(dir, "ai.png") }, fake);
  assert.match(d.content[0].text, /cells of 5\.5 px/);
  const r = await runTool(findTool("fix_pixel_art"), { path: join(dir, "ai.png") }, fake);
  const created = calls.find((c) => c.m === "create_sprite").p;
  const bytes = Buffer.from(created.rgba, "base64");
  assert.ok(match({ width: created.width, height: created.height, data: bytes }, base) >= 0.98);
  assert.ok(created.palette.length <= 6, `palette ${created.palette.length}`);
  assert.equal(r.content[0].type, "image");
  const native = await runTool(findTool("fix_pixel_art"), { path: join(dir, "ai.png"), cell: 1 }, fake);
  assert.equal(native.isError, true);
});
