// normal-map: a hidden normal layer per frame, a lit preview, and matching
// color and normal sheets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDocument, opaque, PNG, tempDir } from "./_helpers.mjs";

const W = 24, dir = tempDir("normal-map");
function disc() {
  const d = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 11.5, y - 11.5) < 10) d.set([200, 80, 60, 255], (y * W + x) * 4);
  return d;
}

export default {
  skill: "normal-map",
  fixture: () => fakeDocument({ width: W, height: W, frames: 2, layers: [{ name: "Ball", frames: [disc(), disc()] }] }),
  steps: [
    { tool: "normal_map", input: { layer: "Ball" } },
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
    assert.equal(results[1].content[0].type, "image");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".png")).sort(), ["ball.png", "ball_n.png"]);
    const a = PNG.sync.read(readFileSync(join(dir, "ball.png"))), b = PNG.sync.read(readFileSync(join(dir, "ball_n.png")));
    assert.deepEqual([a.width, a.height], [W * 2, W]);
    assert.deepEqual([b.width, b.height], [a.width, a.height]);
  },
};
