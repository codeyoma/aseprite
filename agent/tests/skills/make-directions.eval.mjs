// make-directions: the plan says what to mirror and draw; iso_project turns
// a top-down tile into a 2:1 diamond.
import { bounds, colorsOf, fakeDocument, rect, textOf } from "./_helpers.mjs";

export default {
  skill: "make-directions",
  fixture: () => fakeDocument({
    width: 16, height: 16, frames: 2,
    layers: [{ name: "Tile", frames: [rect(16, 16, [4, 4, 11, 11], [0, 135, 81]), rect(16, 16, [4, 4, 11, 11], [0, 135, 81])] }],
    tags: [{ name: "walk_S", from: 1, to: 1 }, { name: "walk_E", from: 2, to: 2 }],
  }),
  steps: [
    { tool: "direction_plan", input: { count: 4 } },
    { tool: "iso_project", input: { layer: "Tile", frame: 1 } },
  ],
  check(fake, results, assert) {
    const plan = textOf(results[0]);
    assert.match(plan, /Have: .*S \(walk_S\).*E \(walk_E\)/s);
    assert.match(plan, /Mirror: W from E \(walk_E\)/);
    assert.match(plan, /Draw: N\./);
    const s = fake.active.sprite;
    assert.equal(s.title, "Isometric");
    assert.deepEqual([s.width, s.height], [16, 8], "an 8x8 tile becomes a 16x8 diamond");
    const d = fake.image(s.layers[0]);
    assert.deepEqual([...colorsOf(d)], ["#008751"], "colors are kept exactly");
    const b = bounds(d, 16);
    assert.ok(b.h === 8 && b.w >= 14, `diamond bounds ${JSON.stringify(b)}`);
    // A diamond: the corners are empty, the center is filled.
    assert.equal(d[3], 0);
    assert.equal(d[(4 * 16 + 8) * 4 + 3], 255);
  },
};
