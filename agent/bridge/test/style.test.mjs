// Recreate from a reference (#40): outline, dithering, style rules, color
// groups, and the recreate tool on a scaled screenshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upscale } from "../dist/pixel_grid.js";
import { analyzeStyle, colorGroups, ditherShare, findOutline } from "../dist/style.js";
import { findTool, runTool } from "../dist/tools.js";

const OUT = [24, 20, 37], G1 = [60, 170, 80], G2 = [120, 220, 120], G0 = [30, 110, 60], SKIN = [255, 204, 170], SKIN_D = [200, 140, 110];
function blob(w = 16, h = 16, outline = OUT) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - w / 2 + 0.5, y - h / 2 + 0.5);
    if (r > w / 2 - 1) continue;
    const c = r > w / 2 - 2 ? outline : y < h / 2 - 2 ? G2 : y > h / 2 + 2 ? G0 : G1;
    d.set([...c, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data: d };
}

test("a dark outline, a selout outline, or none", () => {
  const dark = findOutline(blob());
  assert.equal(dark.kind, "dark");
  assert.deepEqual(dark.colors, ["#181425"]);
  // Selout: each part of the edge is a darker shade of the fill it borders.
  const sel = blob(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    if (sel.data[i] !== OUT[0] || sel.data[i + 3] === 0) continue;
    sel.data.set(y < 6 ? [70, 150, 80] : y > 10 ? [10, 60, 30] : [30, 110, 50], i);
  }
  const so = findOutline(sel);
  assert.equal(so.kind, "selout", JSON.stringify(so));
  assert.equal(so.colors.length, 3);
  // A single dark green outline counts as a one-color outline.
  assert.equal(findOutline(blob(16, 16, [20, 80, 40])).kind, "dark");
  // No outline: the edge is the light fill itself.
  const plain = blob(16, 16, G2);
  assert.equal(findOutline(plain).kind, "none");
});

test("dithering and style rules", () => {
  const w = 8, d = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) d.set([...((x + y) % 2 ? G1 : G2), 255], (y * w + x) * 4);
  assert.ok(ditherShare({ width: w, height: w, data: d }) > 0.9);
  const s = analyzeStyle(blob());
  assert.equal(s.colors, 4);
  assert.ok(s.rules.some((r) => /Outline every shape with #181425, 1 px/.test(r)), s.rules.join("\n"));
  assert.ok(s.rules.some((r) => /about 3 steps/.test(r)), s.rules.join("\n"));
  assert.ok(s.rules.some((r) => /No dithering/.test(r)));
});

test("color groups: outline, then one group per ramp", () => {
  const img = blob(20, 20);
  // A skin ramp patch inside.
  for (const [x, y, c] of [[9, 9, SKIN], [10, 9, SKIN], [9, 10, SKIN_D], [10, 10, SKIN_D]]) img.data.set([...c, 255], (y * 20 + x) * 4);
  const g = colorGroups(img);
  assert.equal(g[0].name, "Outline");
  assert.deepEqual(g[0].colors, ["#181425"]);
  assert.ok(g.length >= 3, JSON.stringify(g));
  const all = g.flatMap((x) => x.colors);
  assert.equal(new Set(all).size, all.length, "each color in one group");
});

test("recreate_from_reference: a x3 screenshot of 3 poses on a solid background", async () => {
  const W = 60, H = 24, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([90, 140, 200, 255], i);
  const pose = blob(16, 16);
  for (let p = 0; p < 3; p++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    if (pose.data[i + 3]) d.set(pose.data.subarray(i, i + 4), ((y + 4 + (p === 1 ? -1 : 0)) * W + x + 2 + p * 20) * 4);
  }
  const shot = upscale({ width: W, height: H, data: d }, 3);
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  const png = new PNG({ width: shot.width, height: shot.height });
  png.data.set(shot.data);
  writeFileSync(join(dir, "shot.png"), PNG.sync.write(png));
  const calls = [];
  const fake = { request: async (m, p) => { calls.push({ m, p }); return { result: m === "split_layer_by_colors" ? { layers: p.groups.map((g) => g.name) } : { title: p.title } }; } };
  const r = await runTool(findTool("recreate_from_reference"), { path: join(dir, "shot.png") }, fake);
  const anim = calls.find((c) => c.m === "create_animation").p;
  assert.equal(anim.frames.length, 3);
  assert.deepEqual([anim.width, anim.height], [14, 14]);
  assert.equal(anim.palette.length, 4);
  assert.equal(calls.find((c) => c.m === "split_layer_by_colors").p.groups[0].name, "Outline");
  const t = r.content[0].text;
  assert.match(t, /3 frames of 14x14 \(the reference was scaled 3x\), 4 colors as the palette, background removed/);
  assert.match(t, /Outline every shape with #181425/);
  assert.match(t, /for study and personal use/);
});
