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

test("shade_sprite and outline_sprite write through put_image", async () => {
  const img = circle();
  const calls = [];
  const fake = {
    async request(m, p) {
      calls.push({ m, p });
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 24, height: 24, frames: [100, 100].map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "Body" }], tags: [], palette: { colors: ["#181425", "#3caa50"] } } } };
      if (m === "snapshot") return { result: { width: 24, height: 24 }, binary: Buffer.from(img.data) };
      return { result: { layer: "L9", name: "AI: x" } };
    },
  };
  const r = await runTool(findTool("shade_sprite"), { frames: "1-2", bands: 3 }, fake);
  const puts = calls.filter((c) => c.m === "put_image");
  assert.equal(puts.length, 2);
  assert.deepEqual([puts[0].p.new_layer, puts[0].p.above, puts[0].p.hide_source, puts[1].p.frame], ["shaded Body", "Body", true, 2]);
  assert.match(r.content[0].text, /Shaded Body in 2 frame\(s\) from top-left with 3 bands/);
  calls.length = 0;
  const o = await runTool(findTool("outline_sprite"), { color: "selout" }, fake);
  assert.equal(calls.filter((c) => c.m === "put_image")[0].p.new_layer, "outline");
  assert.match(o.content[0].text, /outer selout outline \(\d+ px over 1 frame\(s\)\)/);
});
