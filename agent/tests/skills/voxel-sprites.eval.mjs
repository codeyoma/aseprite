// voxel-sprites: layers stacked into a voxel object (saved as .vox), and a
// .vox model rendered in 4 tagged isometric directions.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPalette, parseVox, writeVox } from "../../bridge/dist/voxels.js";
import { colorsOf, fakeDocument, opaque, rect, tempDir, textOf } from "./_helpers.mjs";

const dir = tempDir("voxel-sprites");
const cubePath = join(dir, "cube.vox"), saved = join(dir, "stack.vox");
function cube(n = 3) {
  const voxels = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) voxels.push([x, y, z, 1]);
  const palette = defaultPalette();
  palette[1] = { r: 60, g: 170, b: 80, a: 255 };
  return { sx: n, sy: n, sz: n, voxels, palette };
}

export default {
  skill: "voxel-sprites",
  fixture() {
    writeFileSync(cubePath, writeVox(cube()));
    return fakeDocument({ width: 4, height: 4, layers: [
      { name: "Ground", frames: [rect(4, 4, [0, 0, 3, 3], [171, 82, 54])] },
      { name: "Top", frames: [rect(4, 4, [1, 1, 1, 1], [255, 163, 0])] },
    ] });
  },
  steps: [
    { tool: "layers_to_voxels", input: { directions: 1, save_vox: saved } },
    { tool: "render_voxels", input: { path: cubePath } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /Stacked 2 layers \(17 voxels\)/);
    assert.ok(existsSync(saved));
    const m = parseVox(readFileSync(saved));
    assert.deepEqual([m.sz, m.voxels.length], [2, 17]);
    const stacked = fake.sprites[1];
    assert.equal(stacked.durations.length, 1);
    assert.ok(opaque(fake.image(stacked.layers[0], 1, stacked)) > 0);
    const s = fake.active.sprite;
    assert.equal(s.durations.length, 4);
    assert.deepEqual(s.tags.map((t) => t.name), ["SE", "SW", "NW", "NE"]);
    assert.match(textOf(results[1]), /3x3x3 model \(27 voxels\)/);
    for (const c of fake.images(s.layers[0])) assert.ok(colorsOf(c).size >= 2, "faces are shaded");
  },
};
