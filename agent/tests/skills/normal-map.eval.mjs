// normal-map: a hidden normal layer per frame, emission and specular masks,
// a lit preview, and matching color, normal and mask sheets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDocument, opaque, PNG, tempDir } from "./_helpers.mjs";

const W = 24, dir = tempDir("normal-map");
function disc() {
  const d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 11.5, y - 11.5) < 10) d.set([200, 80, 60, 255], (y * W + x) * 4);
  d.set([255, 224, 64, 255], (12 * W + 12) * 4); // a glowing gem
  return d;
}

export default {
  skill: "normal-map",
  fixture: () => fakeDocument({ width: W, height: W, frames: 2, layers: [{ name: "Ball", frames: [disc(), disc()] }] }),
  steps: [
    { tool: "normal_map", input: { layer: "Ball" } },
    { tool: "make_masks", input: { layer: "Ball", emission: { colors: ["#ffe040"] }, specular: { colors: ["#c85040"], value: 0.5 } } },
    { tool: "light_preview", input: { layer: "Ball", light: { from: "right" } } },
    { tool: "export_normal_sheet", input: { layer: "Ball", dir, name: "ball" } },
  ],
  check(fake, results, assert) {
    const layer = fake.active.sprite.layers.find((l) => l.name === "AI: normal Ball");
    assert.ok(layer, "an 'AI: normal Ball' layer");
    assert.equal(layer.visible, false, "the normal layer is hidden");
    for (const f of [1, 2]) {
      const n = fake.cel("AI: normal Ball", f);
      assert.equal(opaque(n), opaque(disc()), `frame ${f}: one normal per sprite pixel`);
      // Normals face the viewer: blue >= 128; left edge points left (red < 128), right edge right.
      const px = (x, y) => n.subarray((y * W + x) * 4, (y * W + x) * 4 + 4);
      assert.ok(px(12, 12)[2] >= 128 && px(3, 12)[0] < 128 && px(20, 12)[0] > 128);
    }
    for (const k of ["emission", "specular"]) assert.equal(fake.active.sprite.layers.find((l) => l.name === `AI: ${k} Ball`)?.visible, false, `a hidden 'AI: ${k} Ball' layer`);
    const e = fake.cel("AI: emission Ball", 2), s = fake.cel("AI: specular Ball", 1);
    const px = (d, x, y) => [...d.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
    assert.deepEqual(px(e, 12, 12), [255, 255, 255, 255], "the gem glows");
    assert.deepEqual(px(e, 5, 12), [0, 0, 0, 255], "the body does not");
    assert.equal(px(s, 5, 12)[0], 170, "the body is half shiny (quantized)");
    assert.equal(px(s, 12, 12)[0], 0, "the gem is not");
    assert.equal(results[2].content[0].type, "image");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".png")).sort(), ["ball.png", "ball_e.png", "ball_n.png", "ball_s.png"]);
    const a = PNG.sync.read(readFileSync(join(dir, "ball.png"))), b = PNG.sync.read(readFileSync(join(dir, "ball_n.png")));
    assert.deepEqual([a.width, a.height], [W * 2, W]);
    assert.deepEqual([b.width, b.height], [a.width, a.height]);
  },
};
