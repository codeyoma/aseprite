// Ramps, auto-shading and outlines (#39).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hex, parseHex, toOklch } from "../dist/color.js";
import { darker, makeRamp, outline, shadeFlat } from "../dist/shading.js";
import { findTool, runTool } from "../dist/tools.js";

const L = (c) => toOklch(c).L;
function circle(r = 9.5, outlineColor = [24, 20, 37], fill = [60, 170, 80], W = 24) {
  const d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const k = Math.hypot(x - 11.5, y - 11.5);
    if (k < r) d.set([...(outlineColor && k > r - 0.9 ? outlineColor : fill), 255], (y * W + x) * 4);
  }
  return { width: W, height: W, data: d };
}
const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
};

test("ramps are monotonic, keep the base, and shift hue cool to warm", () => {
  for (const base of ["#3caa50", "#ff004d", "#29adff", "#ab5236"]) {
    const ramp = makeRamp(parseHex(base), { steps: 5 });
    const Ls = ramp.map(L);
    for (let i = 1; i < Ls.length; i++) assert.ok(Ls[i] > Ls[i - 1], `${base} lightness ${Ls}`);
    assert.ok(ramp.map(hex).includes(base), `${base} kept`);
  }
  // Green: the shadow moves toward blue (higher hue), the highlight toward yellow (lower hue).
  const g = makeRamp(parseHex("#3caa50"), { steps: 5, hueShift: 30 });
  const h = g.map((c) => toOklch(c).h), base = toOklch(parseHex("#3caa50")).h;
  assert.ok(h[0] > base && h[4] < base, `hues ${h.map((x) => x.toFixed(0))} base ${base.toFixed(0)}`);
});

test("shading a flat circle: lit side lighter, outline kept, only ramp colors", () => {
  const img = circle();
  const { image, ramps } = shadeFlat(img, { light: "top-left", bands: 3, keep: ["#181425"] });
  assert.ok(L(px(image, 8, 8)) > L(px(image, 12, 12)) - 1e-9 && L(px(image, 12, 12)) > L(px(image, 15, 15)), "top-left lit");
  assert.equal(hex(px(image, 8, 3)), "#181425", "outline kept");
  const allowed = new Set([...[...ramps.values()].flat().map(hex), "#181425"]);
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3]) assert.ok(allowed.has(hex({ r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], a: 255 })));
  }
  const right = shadeFlat(img, { light: "right", keep: ["#181425"] }).image;
  assert.ok(L(px(right, 17, 11)) > L(px(right, 5, 11)), "light from the right");
});

test("outlines: selout is a darker shade of the neighbor; inner; 4 vs 8 connectivity", () => {
  const flat = circle(7, null);
  const sel = outline(flat, { color: "selout" });
  const edge = px(sel, 11, 4); // just outside the top of the circle
  assert.equal(edge.a, 255);
  assert.ok(L(edge) < L(parseHex("#3caa50")) - 0.15);
  assert.ok(Math.abs(toOklch(edge).h - toOklch(parseHex("#3caa50")).h) < 40, "same hue family");
  const count = (img) => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++; return n; };
  const o4 = count(outline(flat, { color: "#000000" })), o8 = count(outline(flat, { color: "#000000", connectivity: 8 }));
  assert.ok(o8 > o4 && o4 > count(flat));
  const inner = outline(flat, { mode: "inner", color: "#000000" });
  assert.equal(count(inner), count(flat), "inner recolors, adds nothing");
  assert.equal(hex(px(inner, 11, 5)), "#000000");
  const pal = [parseHex("#000000"), parseHex("#1e6e3c"), parseHex("#3caa50")];
  assert.equal(hex(darker(parseHex("#3caa50"), pal)), "#1e6e3c", "selout snaps to a darker palette color");
});

test("shade_sprite and outline_sprite read every frame in one request and write in one put_images (#114)", async () => {
  const img = circle();
  const calls = [];
  const fake = {
    async request(m, p) {
      calls.push({ m, p });
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 24, height: 24, frames: [100, 100].map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "Body" }], tags: [], palette: { colors: ["#181425", "#3caa50"] } } } };
      if (m === "snapshot") return { result: { width: 24, height: 24 }, binary: Buffer.concat((p.frames ?? [1]).map(() => Buffer.from(img.data))) };
      return { result: { layer: "L9", name: "AI: x" } };
    },
  };
  const r = await runTool(findTool("shade_sprite"), { frames: "1-2", bands: 3 }, fake);
  assert.deepEqual(calls.filter((c) => c.m === "snapshot").map((c) => c.p.frames), [[1, 2]], "one read for both frames");
  const puts = calls.filter((c) => c.m === "put_images");
  assert.equal(puts.length, 1, "one write, one undo step");
  const items = puts[0].p.images;
  assert.deepEqual([items[0].new_layer, items[0].above, items[0].hide_source, items[1].frame], ["shaded Body", "Body", true, 2]);
  assert.match(r.content[0].text, /Shaded Body in 2 frame\(s\) from top-left with 3 bands/);
  calls.length = 0;
  const o = await runTool(findTool("outline_sprite"), { color: "selout" }, fake);
  assert.equal(calls.filter((c) => c.m === "put_images")[0].p.images[0].new_layer, "outline");
  assert.match(o.content[0].text, /outer selout outline \(\d+ px over 1 frame\(s\)\)/);
});

test("manual anti-aliasing fills step corners between two colors, never the background", async () => {
  const { antiAlias, ambientOcclusion, applyOcclusion } = await import("../dist/shading.js");
  const W = 8, H = 8, d = new Uint8Array(W * H * 4);
  const dark = [20, 20, 40, 255], fill = [200, 180, 120, 255];
  // A diagonal staircase: dark on the upper-left, fill below-right; transparent column 0.
  for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) d.set(x - 1 < y ? fill : dark, (y * W + x) * 4);
  const r = antiAlias({ width: W, height: H, data: d });
  assert.ok(r.changed >= 4, `changed ${r.changed}`);
  for (let i = 0; i < r.image.data.length; i += 4) {
    if (!r.image.data[i + 3]) continue;
    assert.ok(d[i + 3] === 255, "only opaque pixels change");
    const L = r.image.data[i] + r.image.data[i + 1];
    assert.ok(L > 40 && L < 380, "a color between the two");
  }
  // A 1 px line across a fill is left alone.
  const line = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) line.set(x === y ? dark : fill, (y * W + x) * 4);
  assert.equal(antiAlias({ width: W, height: H, data: line }).changed, 0);
  // Palette snapping uses only palette colors.
  const pal = [{ r: 110, g: 100, b: 80, a: 255 }, { r: 20, g: 20, b: 40, a: 255 }];
  const snapped = antiAlias({ width: W, height: H, data: d }, { palette: pal });
  for (let i = 0; i < snapped.image.data.length; i += 4) if (snapped.image.data[i + 3]) assert.equal(snapped.image.data[i], 110);
});

test("ambient occlusion darkens where a raised part meets a lower one", async () => {
  const { ambientOcclusion, applyOcclusion } = await import("../dist/shading.js");
  const W = 12, H = 12, d = new Uint8Array(W * H * 4), height = new Float64Array(W * H);
  // A floor (height 0.2) with a raised block (height 1) in the middle.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    d.set([120, 160, 120, 255], (y * W + x) * 4);
    height[y * W + x] = x >= 4 && x < 8 && y >= 4 && y < 8 ? 1 : 0.2;
  }
  const occ = ambientOcclusion({ width: W, height: H, data: d }, height, { radius: 2, levels: 2 });
  assert.ok(occ[5 * W + 3] > 0, "the floor next to the block is occluded");
  assert.equal(occ[0], 0, "far floor is open");
  assert.equal(occ[5 * W + 5], 0, "the top of the block is open");
  const out = applyOcclusion({ width: W, height: H, data: d }, occ);
  assert.ok(out.data[(5 * W + 3) * 4 + 1] < 160, "occluded pixels are darker");
});

test("anti_alias and ambient_occlusion tools through the document", async () => {
  const { fakeDocument } = await import("./helpers/fake_document.mjs");
  const { findTool, runTool } = await import("../dist/tools.js");
  const W = 8, d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) d.set(x < y ? [200, 180, 120, 255] : [20, 20, 40, 255], (y * W + x) * 4);
  const fake = fakeDocument({ width: W, height: W, layers: [{ name: "Body", frames: [d] }], palette: [] });
  let r = await runTool(findTool("anti_alias"), { layer: "Body" }, fake);
  assert.ok(!r.isError && /Softened \d+ step/.test(r.content[0].text), r.content[0].text);
  assert.ok(fake.layerNames().includes("AI: anti-alias Body"));
  r = await runTool(findTool("ambient_occlusion"), { layer: "Body", as_mask: true }, fake);
  assert.ok(!r.isError, r.content[0].text);
  assert.ok(fake.layerNames().includes("AI: ao mask Body"));
});
