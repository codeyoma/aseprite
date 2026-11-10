// recreate-from-reference: a 3x screenshot of 3 poses on a solid background
// becomes a 3-frame sprite at native size, split into color-role layers.
import { join } from "node:path";
import { colorsOf, fakeDocument, tempDir, textOf, upscale, writePng } from "./_helpers.mjs";

const path = join(tempDir("recreate"), "shot.png");
const OUT = [24, 20, 37], G1 = [60, 170, 80], G2 = [120, 220, 120], G0 = [30, 110, 60];
function blob(w = 16, h = 16) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - w / 2 + 0.5, y - h / 2 + 0.5);
    if (r > w / 2 - 1) continue;
    d.set([...(r > w / 2 - 2 ? OUT : y < h / 2 - 2 ? G2 : y > h / 2 + 2 ? G0 : G1), 255], (y * w + x) * 4);
  }
  return d;
}
function screenshot() {
  const W = 60, H = 24, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([90, 140, 200, 255], i);
  const pose = blob();
  for (let p = 0; p < 3; p++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    if (pose[i + 3]) d.set(pose.subarray(i, i + 4), ((y + 4 + (p === 1 ? -1 : 0)) * W + x + 2 + p * 20) * 4);
  }
  return upscale({ width: W, height: H, data: d }, 3);
}

export default {
  skill: "recreate-from-reference",
  fixture() {
    writePng(path, screenshot());
    return fakeDocument({ width: 8, height: 8, layers: [{ name: "Layer 1", frames: [new Uint8Array(8 * 8 * 4)] }] });
  },
  steps: [
    { tool: "style_summary", input: { path } },
    { tool: "detect_background", input: { path } },
    { tool: "find_sprites", input: { path } },
    { tool: "recreate_from_reference", input: { path } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /#181425/, "the style names the outline color");
    const s = fake.active.sprite;
    assert.deepEqual([s.width, s.height, s.durations.length], [14, 14, 3]);
    assert.equal(s.palette.length, 4);
    assert.match(textOf(results[1]), /key color #5a8cc8/);
    assert.match(textOf(results[2]), /^3 sprites in 1 row .*similar sizes/, "the poses are found before recreating");
    assert.match(textOf(results[3]), /\(the reference was scaled 3x\), 4 colors as the palette, background removed/);
    assert.equal(s.layers.at(-1).name, "Outline", "the outline layer is on top");
    assert.deepEqual([...colorsOf(fake.image(s.layers.at(-1)))], ["#181425"]);
    const all = new Set();
    for (const l of s.layers) for (const c of fake.images(l)) for (const x of colorsOf(c)) all.add(x);
    assert.ok(!all.has("#5a8cc8"), "the background is gone");
    assert.equal(all.size, 4);
  },
};
