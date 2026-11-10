// animate: in-betweens with transform_layer, then a squash on the landing frame.
import { bounds, fakeDocument, rect } from "./_helpers.mjs";

const W = 32;

export default {
  skill: "animate",
  fixture: () => fakeDocument({
    width: W, height: W, frames: 5,
    layers: [{ name: "Ball", frames: [rect(W, W, [4, 12, 9, 17], [255, 0, 77])] }],
  }),
  steps: [
    { tool: "transform_layer", input: { layer: "Ball", from_frame: 1, to_frame: 5, move: { dx: 16 }, easing: "linear" } },
    { tool: "squash_stretch", input: { layer: "Ball", frame: 5, amount: -0.3 } },
  ],
  check(fake, results, assert) {
    const b = [1, 2, 3, 4, 5].map((f) => bounds(fake.cel("Ball", f), W));
    for (const [i, x] of b.entries()) assert.ok(x, `frame ${i + 1} has pixels`);
    // Linear in-betweens: the ball moves right by 4 px a frame.
    assert.deepEqual(b.slice(0, 4).map((x) => x.x0), [4, 8, 12, 16]);
    assert.deepEqual([b[3].w, b[3].h], [6, 6], "in-betweens keep the shape");
    // The squash makes the last frame wider and flatter around x ~ 20..25.
    assert.ok(b[4].w > 6 && b[4].h < 6, `squash: ${JSON.stringify(b[4])}`);
    assert.ok(b[4].x0 <= 20 && b[4].x1 >= 25, `squash stays at the end position: ${JSON.stringify(b[4])}`);
  },
};
