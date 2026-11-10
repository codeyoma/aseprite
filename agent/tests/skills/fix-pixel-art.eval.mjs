// fix-pixel-art: a 3x upscaled sprite is detected as 3 px cells and
// rebuilt at its native size, pixel for pixel.
import { join } from "node:path";
import { trim } from "../../bridge/dist/pixel_grid.js";
import { colorsOf, fakeDocument, tempDir, textOf, upscale, writePng } from "./_helpers.mjs";

const N = 24;
const path = join(tempDir("fix-pixel-art"), "upscaled.png");
/** A disc of palette colors in a fixed pattern. */
function native() {
  const pal = [[29, 43, 83], [126, 37, 83], [0, 135, 81], [255, 163, 0]];
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if ((x - N / 2) ** 2 + (y - N / 2) ** 2 < (N / 2.4) ** 2) d.set([...pal[(x * 7 + y * 3 + ((x * y) % 5)) % 4], 255], (y * N + x) * 4);
  }
  return { width: N, height: N, data: d };
}

export default {
  skill: "fix-pixel-art",
  fixture() {
    writePng(path, upscale(native(), 3));
    return fakeDocument({ width: 8, height: 8, layers: [{ name: "Layer 1", frames: [new Uint8Array(8 * 8 * 4)] }] });
  },
  steps: [
    { tool: "detect_pixel_grid", input: { path } },
    { tool: "fix_pixel_art", input: { path } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /cells of 3 px/);
    const s = fake.active.sprite;
    assert.equal(s.title, "Fixed pixel art");
    const want = trim(native());
    assert.deepEqual([s.width, s.height], [want.width, want.height], "native size");
    const got = s.layers[0].cels[0];
    assert.deepEqual(colorsOf(got), colorsOf(want.data));
    assert.ok(Buffer.from(got).equals(Buffer.from(want.data)), "pixel for pixel");
    assert.equal(s.palette.length, 4);
  },
};
