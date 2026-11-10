// model-to-sprites: a rigged GLB robot rendered as 4 directions of its wave clip.
import { join } from "node:path";
import { makeRobot } from "../../bridge/test/helpers/glb.mjs";
import { fakeDocument, opaque, tempDir } from "./_helpers.mjs";

const path = join(tempDir("model-to-sprites"), "robot.glb");

export default {
  skill: "model-to-sprites",
  fixture() {
    makeRobot(path);
    return fakeDocument({ width: 8, height: 8, layers: [{ name: "Layer 1", frames: [new Uint8Array(8 * 8 * 4)] }] });
  },
  steps: [{ tool: "render_model", input: { path, size: 24, directions: 4, animation: "wave", fps: 4 } }],
  check(fake, results, assert) {
    const s = fake.active.sprite;
    assert.deepEqual([s.width, s.height], [24, 24]);
    assert.equal(s.durations.length, 16, "4 directions x 4 frames of a 1 s clip at 4 fps");
    assert.deepEqual(s.tags.map((t) => [t.name, t.from, t.to]), [["wave_S", 1, 4], ["wave_W", 5, 8], ["wave_N", 9, 12], ["wave_E", 13, 16]]);
    for (const [i, c] of s.layers[0].cels.entries()) assert.ok(opaque(c) > 20, `frame ${i + 1} has the robot`);
    assert.ok(!Buffer.from(s.layers[0].cels[0]).equals(Buffer.from(s.layers[0].cels[2])), "the clip animates");
  },
};
