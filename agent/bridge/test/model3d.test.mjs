// 3D model to pixel sprites (#44).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVATIONS, fitFrame, loadModel, renderView } from "../dist/model3d.js";
import { directionNames } from "../dist/model_tools.js";
import { makeRobot } from "./helpers/glb.mjs";

const dir = mkdtempSync(join(tmpdir(), "model3d-"));
const robotPath = join(dir, "robot.glb");
makeRobot(robotPath);

const views8 = Array.from({ length: 8 }, (_, i) => ({ azimuth: i * 45, elevation: ELEVATIONS.isometric }));
function bottomRow(data, size) {
  for (let y = size - 1; y >= 0; y--) for (let x = 0; x < size; x++) if (data[(y * size + x) * 4 + 3]) return y;
  return -1;
}
function colors(data) {
  const s = new Set();
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) s.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  return s;
}

test("GLB loads with nodes, colors and clips", () => {
  const m = loadModel(robotPath);
  assert.deepEqual(m.clips.map((c) => c.name), ["wave"]);
  assert.equal(Math.round(m.clips[0].duration * 10) / 10, 1);
  const tris = m.triangles();
  assert.equal(tris.length, 36); // 3 boxes x 12 triangles
  // The head sits on the body (parent transform applied).
  const top = Math.max(...tris.flatMap((t) => [t.a[1], t.b[1], t.c[1]]));
  assert.ok(Math.abs(top - 2) < 1e-4, `top ${top}`);
});

test("every direction stands on the same ground row, fully opaque pixels only", () => {
  // From the side the ground plane is a line, so every facing ends on one row
  // (from above, the nearest bottom corner varies by facing, as it should).
  const m = loadModel(robotPath);
  const tris = m.triangles();
  const side = views8.map((v) => ({ ...v, elevation: 0 }));
  const fit = fitFrame([tris], side);
  const rows = side.map((v) => {
    const d = renderView(tris, v, fit, { size: 32 });
    for (let i = 3; i < d.length; i += 4) assert.ok(d[i] === 0 || d[i] === 255);
    return bottomRow(d, 32);
  });
  assert.ok(Math.max(...rows) - Math.min(...rows) <= 1, `rows ${rows}`);
  assert.ok(rows[0] >= 28);
});

test("toon bands limit the shades per material", () => {
  const m = loadModel(robotPath);
  const tris = m.triangles();
  const fit = fitFrame([tris], views8);
  const d2 = renderView(tris, views8[1], fit, { size: 48, bands: 2 });
  const d4 = renderView(tris, views8[1], fit, { size: 48, bands: 4 });
  // 3 materials: at most bands shades each.
  assert.ok(colors(d2).size <= 6, `bands 2: ${colors(d2).size}`);
  assert.ok(colors(d4).size > colors(d2).size);
});

test("the wave clip moves the arm", () => {
  const m = loadModel(robotPath);
  const a = m.triangles("wave", 0), b = m.triangles("wave", 0.5);
  const fit = fitFrame([a, b], [views8[0]]);
  const ra = renderView(a, views8[0], fit, { size: 32 }), rb = renderView(b, views8[0], fit, { size: 32 });
  let diff = 0;
  for (let i = 3; i < ra.length; i += 4) if (ra[i] !== rb[i]) diff++;
  assert.ok(diff > 5, `diff ${diff}`);
});

test("OBJ with .mtl colors", () => {
  writeFileSync(join(dir, "cube.mtl"), "newmtl green\nKd 0.1 0.8 0.2\n");
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const f = ["1 2 3 4", "5 8 7 6", "1 5 6 2", "2 6 7 3", "3 7 8 4", "4 8 5 1"];
  writeFileSync(join(dir, "cube.obj"), ["mtllib cube.mtl", ...v.map((p) => `v ${p.join(" ")}`), "usemtl green", ...f.map((x) => `f ${x}`)].join("\n"));
  const m = loadModel(join(dir, "cube.obj"));
  const tris = m.triangles();
  assert.equal(tris.length, 12);
  assert.ok(tris.every((t) => t.color[1] > 0.7));
  const d = renderView(tris, views8[1], fitFrame([tris], [views8[1]]), { size: 16 });
  for (const c of colors(d)) { const [r, g, b] = c.split(",").map(Number); assert.ok(g > r && g > b, c); }
});

test("direction names", () => {
  assert.deepEqual(directionNames(4), ["S", "W", "N", "E"]);
  assert.equal(directionNames(8)[3], "NW");
  assert.equal(directionNames(16).length, 16);
});
