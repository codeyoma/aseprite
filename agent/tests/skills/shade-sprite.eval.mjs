// shade-sprite: a ramp, light from the top-left on a flat blob, then an outline.
import { bounds, colorsOf, fakeDocument, rect, textOf } from "./_helpers.mjs";

const W = 12;
const lum = (d, x, y) => { const i = (y * W + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };

export default {
  skill: "shade-sprite",
  fixture: () => fakeDocument({ width: W, height: W, palette: ["#3caa50"], layers: [{ name: "Blob", frames: [rect(W, W, [2, 2, 9, 9], [60, 170, 80])] }] }),
  steps: [
    { tool: "make_ramp", input: { base: "#3caa50", steps: 3 } },
    { tool: "shade_sprite", input: { layer: "Blob", light: "top-left" } },
    { tool: "outline_sprite", input: { layer: "Blob" } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /#3caa50/i);
    const shaded = fake.cel("AI: shaded Blob");
    assert.deepEqual(bounds(shaded, W), bounds(fake.cel("Blob"), W), "same silhouette");
    assert.ok(colorsOf(shaded).size >= 3, `bands: ${[...colorsOf(shaded)]}`);
    assert.ok(lum(shaded, 3, 3) > lum(shaded, 8, 8), "lit from the top-left");
    assert.equal(fake.active.sprite.layers.find((l) => l.name === "Blob").visible, false, "the source is hidden");
    const o = fake.cel("AI: outline");
    assert.deepEqual(bounds(o, W), { x0: 1, y0: 1, x1: 10, y1: 10, w: 10, h: 10 }, "a ring around the blob");
    for (let y = 2; y <= 9; y++) for (let x = 2; x <= 9; x++) assert.equal(o[(y * W + x) * 4 + 3], 0, "outer outline only");
  },
};
