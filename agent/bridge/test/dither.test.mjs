// Dithering and palette swaps (#48).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hex, parseHex } from "../dist/color.js";
import { applyLut, applyMap, ditherGradient, ditherRamp, ditherToPalette, paletteLut, rampMap } from "../dist/dither.js";
import { findTool, runTool } from "../dist/tools.js";

const A = parseHex("#1d2b53"), B = parseHex("#29adff");
const px = (img, x, y) => hex({ r: img.data[(y * img.width + x) * 4], g: img.data[(y * img.width + x) * 4 + 1], b: img.data[(y * img.width + x) * 4 + 2], a: 255 });

test("Bayer 4x4 between two colors gives the exact pattern", () => {
  // At t = 0.5, a pixel takes B where the Bayer threshold is below 0.5: 8 of 16, in the Bayer layout.
  const expected = [[1, 0, 1, 0], [0, 1, 0, 1], [1, 0, 1, 0], [0, 1, 0, 1]];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(hex(ditherRamp([A, B], 0.5, x, y, "bayer4")), expected[y][x] ? "#29adff" : "#1d2b53", `${x},${y}`);
  }
  const img = ditherGradient(16, 4, { colors: [A, B], direction: "horizontal" });
  const colors = new Set();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) colors.add(px(img, x, y));
  assert.deepEqual([...colors].sort(), ["#1d2b53", "#29adff"]);
  assert.equal(px(img, 0, 0), "#1d2b53");
  assert.equal(px(img, 15, 3), "#29adff");
});

test("a smooth gradient becomes dithered palette steps, not bands", () => {
  const w = 32, d = new Uint8Array(w * 4 * 4);
  for (let x = 0; x < w; x++) for (let y = 0; y < 4; y++) {
    const t = x / (w - 1);
    d.set([Math.round(A.r + (B.r - A.r) * t), Math.round(A.g + (B.g - A.g) * t), Math.round(A.b + (B.b - A.b) * t), 255], (y * w + x) * 4);
  }
  const out = ditherToPalette({ width: w, height: 4, data: d }, [A, B]);
  const share = (x) => { let n = 0; for (let y = 0; y < 4; y++) if (px(out, x, y) === "#29adff") n++; return n / 4; };
  assert.equal(share(0), 0);
  assert.equal(share(w - 1), 1);
  const mid = [12, 13, 14, 15, 16, 17, 18, 19].map(share);
  assert.ok(mid.some((s) => s > 0 && s < 1), `mixed columns in the middle: ${mid}`);
});

test("palette swap keeps ramp order; the LUT recolors like the swap", () => {
  const blue = ["#1d2b53", "#29adff", "#c2f0ff"].map(parseHex), red = ["#7e2553", "#ff004d", "#ffccaa"].map(parseHex);
  const map = rampMap(blue, red);
  assert.deepEqual([...map.values()].map(hex), ["#7e2553", "#ff004d", "#ffccaa"]);
  const img = { width: 3, height: 1, data: new Uint8Array([...blue.flatMap((c) => [c.r, c.g, c.b, 255])]) };
  const swapped = applyMap(img, map);
  const base = [...blue, parseHex("#000000")];
  const { index, lut, missing } = paletteLut(img, base, [map]);
  assert.equal(missing, 0);
  assert.deepEqual([index.data[0], index.data[4], index.data[8]], [0, 1, 2]);
  assert.deepEqual(Buffer.from(applyLut(index, lut, 0).data), Buffer.from(img.data));
  assert.deepEqual(Buffer.from(applyLut(index, lut, 1).data), Buffer.from(swapped.data));
});

test("export_palette_lut writes the index, the LUT and a shader", async () => {
  const blue = ["#1d2b53", "#29adff"].map(parseHex);
  const img = Buffer.from([...blue.flatMap((c) => [c.r, c.g, c.b, 255]), 0, 0, 0, 0]);
  const fake = {
    async request(m) {
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 3, height: 1, frames: [100].map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "Hero" }], tags: [], palette: { colors: ["#1d2b53", "#29adff"] } } } };
      if (m === "snapshot") return { result: { width: 3, height: 1 }, binary: img };
      return { result: {} };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "lut-"));
  const r = await runTool(findTool("export_palette_lut"), { dir, name: "hero", variants: [{ name: "red", from: ["#1d2b53", "#29adff"], to: ["#7e2553", "#ff004d"] }] }, fake);
  assert.match(r.content[0].text, /hero_lut\.png \(2 colors x 2 rows\).*Row 0 reproduces the sprite exactly/s);
  for (const f of ["hero_index.png", "hero_lut.png", "hero_swap.gdshader"]) assert.ok(existsSync(join(dir, f)), f);
});
