// Voxels and 2.5D (#45).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hex } from "../dist/color.js";
import { defaultPalette, faceShades, layersToModel, parseVox, renderIso, rotateModel, writeVox } from "../dist/voxels.js";
import { findTool, runTool } from "../dist/tools.js";

function cube(n = 3, idx = 1) {
  const vox = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) vox.push([x, y, z, idx]);
  const palette = defaultPalette();
  palette[1] = { r: 60, g: 170, b: 80, a: 255 };
  return { sx: n, sy: n, sz: n, voxels: vox, palette };
}
const colorsOf = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 })); return s; };

test(".vox write and parse round trip", () => {
  const m = cube();
  const back = parseVox(writeVox(m));
  assert.deepEqual([back.sx, back.sy, back.sz, back.voxels.length], [3, 3, 3, 27]);
  assert.deepEqual(back.palette[1], { r: 60, g: 170, b: 80, a: 255 });
  assert.throws(() => parseVox(Buffer.from("nope")), /Not a MagicaVoxel/);
});

test("isometric render: exactly 3 shades per material, top lightest", () => {
  const img = renderIso(cube());
  const shades = faceShades({ r: 60, g: 170, b: 80, a: 255 }).map(hex);
  assert.deepEqual([...colorsOf(img)].sort(), [...shades].sort());
  // The top of the cube is the first opaque row; the bottom rows are side faces.
  const row = (y) => colorsOf({ width: img.width, height: 1, data: img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4) });
  assert.ok(row(0).has(shades[0]));
  assert.ok(!row(img.height - 1).has(shades[0]));
  assert.deepEqual([img.width, img.height], [12, 12]);
});

test("rotation turns the model; layers stack into a model", () => {
  const m = { sx: 2, sy: 1, sz: 1, voxels: [[0, 0, 0, 1], [1, 0, 0, 2]], palette: defaultPalette() };
  const r = rotateModel(m, 1);
  assert.deepEqual([r.sx, r.sy], [1, 2]);
  assert.deepEqual(rotateModel(m, 4).voxels, m.voxels);
  const layer = (on) => ({ width: 2, height: 2, data: new Uint8Array(on.flatMap((v) => (v ? [200, 50, 50, 255] : [0, 0, 0, 0]))) });
  const stacked = layersToModel([layer([1, 1, 1, 1]), layer([1, 0, 0, 0])]);
  assert.deepEqual([stacked.sz, stacked.voxels.length], [2, 5]);
});

test("render_voxels opens 4 tagged directions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vox-"));
  writeFileSync(join(dir, "box.vox"), writeVox(cube()));
  const calls = [];
  const fake = { async request(m, p) { calls.push({ m, p }); return { result: { title: p.title } }; } };
  const r = await runTool(findTool("render_voxels"), { path: join(dir, "box.vox") }, fake);
  const a = calls[0].p;
  assert.equal(a.frames.length, 4);
  assert.deepEqual(a.tags.map((t) => t.name), ["SE", "SW", "NW", "NE"]);
  assert.deepEqual(a.palette, ["#3caa50"]);
  assert.match(r.content[0].text, /3x3x3 model \(27 voxels\)/);
});
