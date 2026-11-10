// Normal maps and 2D lighting (#47).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { heightField, light, normalMap } from "../dist/normals.js";
import { findTool, runTool } from "../dist/tools.js";

const W = 24;
function disc() {
  const d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 11.5, y - 11.5) < 10) d.set([60, 170, 80, 255], (y * W + x) * 4);
  return { width: W, height: W, data: d };
}
const n = (img, x, y) => [0, 1, 2].map((k) => img.data[(y * img.width + x) * 4 + k] / 127.5 - 1);

test("a sphere's normals point outward (OpenGL: green up)", () => {
  const map = normalMap(disc());
  assert.ok(n(map, 11, 3)[1] > 0.3, "top faces up");
  assert.ok(n(map, 11, 20)[1] < -0.3, "bottom faces down");
  assert.ok(n(map, 20, 11)[0] > 0.3, "right faces right");
  assert.ok(n(map, 3, 11)[0] < -0.3, "left faces left");
  assert.ok(n(map, 11, 11)[2] > 0.95, "center faces the viewer");
  assert.equal(map.data[3], 0, "outside stays transparent");
  const dx = normalMap(disc(), { convention: "directx" });
  assert.ok(n(dx, 11, 3)[1] < -0.3, "DirectX flips green");
});

test("quantized normals use few values; smooth ones many", () => {
  const count = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(img.data.slice(i, i + 3).join()); return s.size; };
  assert.ok(count(normalMap(disc(), { levels: 2 })) <= 17);
  assert.ok(count(normalMap(disc(), { levels: 0 })) > 30);
  const h = heightField(disc(), { source: "luminance" });
  assert.ok(h[11 * W + 11] > 0.5);
});

test("lighting: brighter on the light's side", () => {
  const img = disc(), map = normalMap(img);
  const lit = light(img, map, { dir: [-1, 1, 1] });
  const g = (x, y) => lit.data[(y * W + x) * 4 + 1];
  assert.ok(g(5, 5) > g(18, 18) + 30, `${g(5, 5)} vs ${g(18, 18)}`);
  const pt = light(img, map, { point: [22, 11, 6] });
  assert.ok(pt.data[(11 * W + 20) * 4 + 1] > pt.data[(11 * W + 3) * 4 + 1], "a point light on the right");
});

test("normal_map writes a hidden layer per frame; export writes matching sheets", async () => {
  const img = disc();
  const calls = [];
  const fake = {
    async request(m, p) {
      calls.push({ m, p });
      if (m === "execute_lua") return { result: { ok: true, value: { frames: 2, frame: 1, layer: "Ball", palette: [] } } };
      if (m === "snapshot") return { result: { width: W, height: W }, binary: Buffer.from(p.layer === "AI: normal Ball" ? normalMap(img).data : img.data) };
      return { result: {} };
    },
  };
  await runTool(findTool("normal_map"), {}, fake);
  const puts = calls.filter((c) => c.m === "put_image");
  assert.deepEqual(puts.map((p) => [p.p.new_layer, p.p.hide, p.p.frame]), [["normal Ball", true, 1], ["normal Ball", true, 2]]);
  const prev = await runTool(findTool("light_preview"), { light: { from: "right" } }, fake);
  assert.equal(prev.content[0].type, "image");
  const dir = mkdtempSync(join(tmpdir(), "nrm-"));
  await runTool(findTool("export_normal_sheet"), { dir }, fake);
  const a = PNG.sync.read(readFileSync(join(dir, "ball.png"))), b = PNG.sync.read(readFileSync(join(dir, "ball_n.png")));
  assert.deepEqual([a.width, a.height], [W * 2, W]);
  assert.deepEqual([b.width, b.height], [a.width, a.height]);
  assert.ok(existsSync(join(dir, "ball_n.png")));
});
