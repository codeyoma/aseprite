// sprite-effects: preview a juice effect, apply it after the landing frame, then a smear over a fast dash; each
// lands on its own copy layer with the source hidden.
import { fakeDocument, textOf } from "./_helpers.mjs";

const box = (w, h, [x0, y0, x1, y1], c) => {
  const d = new Uint8Array(w * h * 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([...c, 255], (y * w + x) * 4);
  return d;
};

export default {
  skill: "sprite-effects",
  fixture() {
    return fakeDocument({
      width: 64, height: 32, durations: [100, 100, 100], layer: "Slime",
      layers: [{ name: "Slime", frames: [0, 1, 2].map((i) => box(64, 32, [4 + 18 * i, 14, 13 + 18 * i, 29], [60, 200, 90])) }],
      tags: [{ name: "dash", from: 1, to: 3 }],
    });
  },
  steps: [
    { tool: "juice", input: { effect: "squash", layer: "Slime", frame: 1, preview: true } },
    { tool: "juice", input: { effect: "squash", layer: "Slime", frame: 1, frames: 4 } },
    { tool: "smear", input: { mode: "sweep", layer: "Slime", frames: "5-7" } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /nothing changed/);
    assert.match(textOf(results[1]), /inserted 4 frames/);
    assert.equal(fake.active.sprite.durations.length, 7);
    assert.ok(fake.cel("AI: juice Slime", 2), "the squash is on the juice copy");
    assert.ok(!results[2].isError, textOf(results[2]));
  },
};
