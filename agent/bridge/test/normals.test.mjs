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
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: W, height: W, frames: [{ durationMs: 100 }, { durationMs: 100 }], layers: [{ id: "L1", name: "Ball" }], tags: [], palette: { colors: [] } } } };
      if (m === "snapshot") {
        const one = Buffer.from(p.layer === "AI: normal Ball" ? normalMap(img).data : img.data);
        return { result: { width: W, height: W }, binary: Buffer.concat((p.frames ?? [1]).map(() => one)) };
      }
      return { result: {} };
    },
  };
  await runTool(findTool("normal_map"), {}, fake);
  const puts = calls.filter((c) => c.m === "put_images");
  assert.equal(puts.length, 1, "one write for both frames (#114)");
  assert.deepEqual(puts[0].p.images.map((i) => [i.new_layer, i.hide, i.frame]), [["normal Ball", true, 1], ["normal Ball", true, 2]]);
  const prev = await runTool(findTool("light_preview"), { light: { from: "right" } }, fake);
  assert.equal(prev.content[0].type, "image");
  const dir = mkdtempSync(join(tmpdir(), "nrm-"));
  await runTool(findTool("export_normal_sheet"), { dir }, fake);
  const a = PNG.sync.read(readFileSync(join(dir, "ball.png"))), b = PNG.sync.read(readFileSync(join(dir, "ball_n.png")));
  assert.deepEqual([a.width, a.height], [W * 2, W]);
  assert.deepEqual([b.width, b.height], [a.width, a.height]);
  assert.ok(existsSync(join(dir, "ball_n.png")));
});

// Emission and specular masks (#67).
import { emissionMask, quantizeLevel, specularMask } from "../dist/masks.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

// A dull body (8x8) with a bright yellow lamp (2x2) and a gray metal ramp row.
const M = 8;
function lamp() {
  const d = rect(M, M, [0, 0, 7, 7], [70, 60, 90]);
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) d.set([255, 230, 60, 255], (y * M + x) * 4);
  [[40, 40, 48], [110, 110, 120], [200, 200, 210], [250, 250, 255]].forEach((c, x) => d.set([...c, 255], (7 * M + x) * 4));
  d.set([0, 0, 0, 0], 0); // one transparent pixel
  return { width: M, height: M, data: d };
}
const at = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test("emission mask: threshold picks bright saturated pixels; colors, painted layer and keep_color", () => {
  const img = lamp();
  const e = emissionMask(img);
  assert.deepEqual(at(e, 3, 3), [255, 255, 255, 255], "the lamp glows");
  assert.deepEqual(at(e, 1, 1), [0, 0, 0, 255], "the body does not");
  assert.deepEqual(at(e, 3, 7), [0, 0, 0, 255], "bright but gray does not");
  assert.equal(at(e, 0, 0)[3], 0, "outside stays transparent");
  const byColor = emissionMask(img, { colors: ["#463c5a"], keepColor: true });
  assert.deepEqual(at(byColor, 1, 1), [70, 60, 90, 255], "a listed color glows in its own color");
  assert.deepEqual(at(byColor, 3, 3), [0, 0, 0, 255]);
  const painted = { width: M, height: M, data: rect(M, M, [6, 0, 6, 0], [255, 0, 0]) };
  const p = emissionMask(img, { painted, keepColor: true });
  assert.deepEqual(at(p, 6, 0), [255, 0, 0, 255], "painted pixels glow in the painted color");
  assert.deepEqual(at(p, 3, 3), [0, 0, 0, 255], "with a painted layer only it glows");
});

test("specular mask: lightness steps, colors with flat values, quantized grays", () => {
  assert.equal(quantizeLevel(0.4, 4), 1 / 3);
  assert.equal(quantizeLevel(1.3, 4), 1);
  const img = lamp();
  const s = specularMask(img);
  const grays = new Set();
  for (let i = 0; i < s.data.length; i += 4) if (s.data[i + 3]) grays.add(s.data[i]);
  assert.ok([...grays].every((g) => [0, 85, 170, 255].includes(g)), `4 steps: ${[...grays]}`);
  assert.ok(at(s, 3, 7)[0] > at(s, 1, 7)[0], "lighter is shinier");
  assert.equal(at(s, 0, 7)[0], 0, "the darkest metal is dull");
  const metal = specularMask(img, { colors: ["#282830", "#6e6e78"], values: { "#6e6e78": 1 }, value: 0.5 });
  assert.deepEqual(at(metal, 1, 7), [255, 255, 255, 255], "per-color value");
  assert.equal(at(metal, 0, 7)[0], 170, "flat value 0.5 rounds to the nearest of 4 steps");
  assert.equal(at(metal, 3, 3)[0], 0, "unlisted colors are not shiny");
  assert.equal(at(metal, 0, 0)[3], 0);
});

test("lighting with masks: emission shows unlit, specular adds a highlight", () => {
  const img = disc(), map = normalMap(img);
  const white = (fill) => ({ width: W, height: W, data: rect(W, W, [0, 0, W - 1, W - 1], fill) });
  const dark = light(img, map, { dir: [0, 0, 1], ambient: 0 }, "opengl");
  const glow = light(img, map, { dir: [1, -1, 0.1], ambient: 0 }, "opengl", { emission: white([255, 255, 255]) });
  assert.deepEqual(at(glow, 4, 11).slice(0, 3), [60, 170, 80], "glowing pixels keep their full color away from the light");
  const shiny = light(img, map, { dir: [0, 0, 1], ambient: 0 }, "opengl", { specular: white([255, 255, 255]) });
  assert.ok(at(shiny, 11, 11)[0] > at(dark, 11, 11)[0] + 100, `${at(shiny, 11, 11)} vs ${at(dark, 11, 11)}`);
});

test("make_masks writes hidden layers per frame; preview and both exports use them", async () => {
  const fake = fakeDocument({ width: M, height: M, frames: 2, layers: [{ name: "Robot", frames: [lamp().data, lamp().data] }] });
  let r = await runTool(findTool("normal_map"), { layer: "Robot" }, fake);
  r = await runTool(findTool("make_masks"), { layer: "Robot", specular: { colors: ["#c8c8d2", "#fafaff"], value: 1 } }, fake);
  assert.ok(!r.isError, r.content[0].text);
  for (const k of ["emission", "specular"]) {
    const l = fake.active.sprite.layers.find((x) => x.name === `AI: ${k} Robot`);
    assert.ok(l && !l.visible, `hidden AI: ${k} Robot`);
    assert.ok(fake.cel(`AI: ${k} Robot`, 2), "frame 2 too");
  }
  assert.deepEqual(at({ width: M, height: M, data: fake.cel("AI: emission Robot", 2) }, 4, 4), [255, 255, 255, 255]);
  assert.deepEqual(at({ width: M, height: M, data: fake.cel("AI: specular Robot", 1) }, 2, 7), [255, 255, 255, 255]);
  assert.match(r.content[0].text, /8 glowing px.*4 shiny px/);
  const one = await runTool(findTool("make_masks"), { layer: "Robot", kind: "emission", emission: { colors: ["#123456"] } }, fake);
  assert.match(one.content[0].text, /No emission pixels/);
  await runTool(findTool("make_masks"), { layer: "Robot", kind: "emission" }, fake);
  const prev = await runTool(findTool("light_preview"), { layer: "Robot" }, fake);
  assert.match(prev.content[1].text, /with the emission and specular masks/);
  const dir = mkdtempSync(join(tmpdir(), "msk-"));
  await runTool(findTool("export_normal_sheet"), { layer: "Robot", dir }, fake);
  for (const f of ["robot.png", "robot_n.png", "robot_e.png", "robot_s.png"]) assert.ok(existsSync(join(dir, f)), f);
  const e = PNG.sync.read(readFileSync(join(dir, "robot_e.png")));
  assert.deepEqual([e.width, e.height], [M * 2, M]);
  const eng = mkdtempSync(join(tmpdir(), "msk-eng-"));
  await runTool(findTool("export_for_engine"), { engine: "godot", dir: eng, name: "robot", padding: 1 }, fake);
  const a = PNG.sync.read(readFileSync(join(eng, "robot.png"))), s = PNG.sync.read(readFileSync(join(eng, "robot_s.png")));
  assert.ok(existsSync(join(eng, "robot_e.png")));
  assert.deepEqual([s.width, s.height], [a.width, a.height], "masks placed like the color frames");
  assert.match(readFileSync(join(eng, "HOW_TO_IMPORT.txt"), "utf8"), /robot_e\.png/);
});
