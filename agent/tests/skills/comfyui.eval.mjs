// comfyui: two pose images with hip keypoints become the keys of a tagged clip, lined up, on one palette;
// after advance, inbetween fills the frames between them.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fakeDocument, opaque, tempDir, textOf, writePng } from "./_helpers.mjs";

const dir = tempDir("comfyui");
const S = 4;
function pose(x, y) {
  const W = 64, H = 64, d = new Uint8Array(W * H * 4);
  for (let yy = y * S; yy < (y + 6) * S; yy++) for (let xx = x * S; xx < (x + 3) * S; xx++) d.set([40, 60, 200, 255], (yy * W + xx) * 4);
  return { width: W, height: H, data: d };
}
function keypoints(name, x, y) {
  const flat = Array(18 * 3).fill(0);
  flat.splice(8 * 3, 3, (x + 1) * S, (y + 5) * S, 1);
  flat.splice(11 * 3, 3, (x + 2) * S, (y + 5) * S, 1);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ people: [{ pose_keypoints_2d: flat }], canvas_width: 64, canvas_height: 64 }));
  return p;
}
const a = join(dir, "a.png"), b = join(dir, "b.png");

export default {
  skill: "comfyui",
  fixture() {
    writePng(a, pose(2, 4));
    writePng(b, pose(8, 6));
    return fakeDocument({ width: 16, height: 16, frames: 3, tags: [{ name: "idle", from: 1, to: 3 }], layers: [{ name: "Base", frames: [] }] });
  },
  steps: [
    { tool: "poses_to_frames", input: { images: [a, b], keypoints: [keypoints("a.json", 2, 4), keypoints("b.json", 8, 6)], tag: "idle", frames: [1, 3], scale: S, layer: "Body" } },
    { tool: "motion_clip", input: { action: "plan", tag: "idle", keys: [1, { frame: 3, pose: "same pose, held", hold: true }] } },
    { tool: "motion_clip", input: { action: "advance", tag: "idle" } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /Put 2 poses on frames 1, 3 at 4 source px per pixel, lined up by the hips/);
    const s = fake.active.sprite;
    const body = s.layers.find((l) => l.name === "AI: Body");
    const imgs = fake.images(body);
    assert.equal(opaque(imgs[0]), 18);
    assert.deepEqual(imgs[0], imgs[2], "lined up by the hips, the two poses are the same pixels");
    assert.match(textOf(results[2]), /stage "inbetweens"/);
    const clip = JSON.parse(s.motion).clips.idle;
    assert.ok(clip.keys[1].landmarks?.mid_hip, "re-planning keeps the keys' landmarks");
  },
};
