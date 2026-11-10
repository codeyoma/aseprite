// dither: a two-color gradient on a new layer, and a gray ramp dithered to black and white.
import { colorsOf, fakeDocument, opaque, textOf } from "./_helpers.mjs";

const W = 16, H = 8;
function grayRamp() {
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = Math.round((x / (W - 1)) * 255); d.set([v, v, v, 255], (y * W + x) * 4); }
  return d;
}

export default {
  skill: "dither",
  fixture: () => fakeDocument({ width: W, height: H, layers: [{ name: "Sky", frames: [grayRamp()] }] }),
  steps: [
    { tool: "make_ramp", input: { base: "#29adff", steps: 4 } },
    { tool: "dither_gradient", input: { colors: ["#1d2b53", "#29adff"], direction: "horizontal", area: "canvas" } },
    { tool: "dither_to_palette", input: { layer: "Sky", colors: ["#000000", "#ffffff"] } },
  ],
  check(fake, results, assert) {
    assert.ok((textOf(results[0]).match(/#[0-9a-f]{6}/gi) ?? []).length >= 4, textOf(results[0]));
    const g = fake.cel("AI: dither");
    assert.equal(opaque(g), W * H, "the gradient fills the canvas");
    assert.deepEqual([...colorsOf(g)].sort(), ["#1d2b53", "#29adff"]);
    // Left column mostly the first color, right column mostly the second.
    const at = (x, y) => "#" + [...g.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)].map((v) => v.toString(16).padStart(2, "0")).join("");
    const col = (x) => Array.from({ length: H }, (_, y) => at(x, y));
    assert.ok(col(0).every((c) => c === "#1d2b53") && col(W - 1).every((c) => c === "#29adff"));
    const d = fake.cel("AI: dithered Sky");
    assert.deepEqual([...colorsOf(d)].sort(), ["#000000", "#ffffff"]);
    assert.equal(opaque(d), W * H);
    const sky = fake.active.sprite.layers.find((l) => l.name === "Sky");
    assert.equal(sky.visible, false, "the source layer is hidden");
  },
};
