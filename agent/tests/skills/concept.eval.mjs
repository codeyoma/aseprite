// concept: a 4-panel storyboard (a figure stepping right) is read into a pixel spec, put on 4 frames of a locked
// reference layer, and the art (frame 1's pose copied to every new frame) is compared with it: the largest
// mismatches are the frames where the reference has moved off the art entirely.
import { join } from "node:path";
import { bounds, fakeDocument, tempDir, textOf, writePng } from "./_helpers.mjs";

const path = join(tempDir("concept"), "storyboard.png");
function storyboard() {
  const W = 256, H = 64, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([255, 255, 255, 255], i);
  const fill = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([...c, 255], (y * W + x) * 4); };
  for (let p = 0; p < 4; p++) {
    const x = p * 64 + 10 + 10 * p;
    fill(x, 32, x + 11, 55, [24, 20, 37]);
    fill(x + 2, 42, x + 9, 53, [200, 40, 60]);
  }
  return { width: W, height: H, data: d };
}
// The art in frame 1: the panel-1 figure at 32x32 (x 5-10, y 16-27).
function art() {
  const d = new Uint8Array(32 * 32 * 4);
  for (let y = 16; y <= 27; y++) for (let x = 5; x <= 10; x++) d.set([24, 20, 37, 255], (y * 32 + x) * 4);
  return d;
}

export default {
  skill: "concept",
  fixture() {
    writePng(path, storyboard());
    return fakeDocument({ width: 32, height: 32, layers: [{ name: "Art", frames: [art()] }] });
  },
  steps: [
    { tool: "concept_spec", input: { image: path, panels: { cols: 4, rows: 1 } } },
    { tool: "storyboard_to_frames", input: { image: path, panels: { cols: 4, rows: 1 } } },
    { tool: "mismatch_regions", input: { top: 3 } },
  ],
  check(fake, results, assert) {
    const spec = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(textOf(results[0]))[1]);
    assert.deepEqual(spec.frames.map((f) => f.bounds), [0, 1, 2, 3].map((i) => [5 + 5 * i, 16, 10 + 5 * i, 27]), "bounds per panel");
    const s = fake.active.sprite;
    assert.equal(s.durations.length, 4, "a frame per panel");
    for (let f = 1; f <= 4; f++) {
      const b = bounds(fake.cel("AI: Reference", f), 32);
      assert.deepEqual([b.x0, b.y0, b.x1, b.y1], [5 + 5 * (f - 1), 16, 10 + 5 * (f - 1), 27], `reference frame ${f}`);
    }
    const ref = s.layers.find((l) => l.name === "AI: Reference");
    assert.equal(ref.visible, false, "the reference is hidden");
    if (ref.editable !== undefined) assert.equal(ref.editable, false, "the reference is locked");
    assert.match(textOf(results[1]), /hidden and locked; added 3 frames, one undo step/);
    assert.equal(fake.active.layer.name, "Art", "the art layer stays active");
    assert.match(textOf(results[2]), /frame 1: overlap 100%/);
    // Frames 3 and 4 no longer overlap at all: their whole figures (72 px) come first, ahead of frame 2's slivers.
    const top = [...textOf(results[2]).matchAll(/^\d\. frame (\d), \w+ (\d+) px/gm)].map((m) => [+m[1], +m[2]]);
    assert.deepEqual(top, [[3, 72], [3, 72], [4, 72]], "largest first");
  },
};
