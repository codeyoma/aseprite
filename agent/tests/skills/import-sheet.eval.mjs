// import-sheet: a 4x2 grid sheet becomes 8 frames of 16x16 with a tag per row.
import { join } from "node:path";
import { fakeDocument, opaque, tempDir, writePng } from "./_helpers.mjs";

const path = join(tempDir("import-sheet"), "hero.png");
function sheet() {
  const W = 64, H = 32, d = new Uint8Array(W * H * 4);
  const fill = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) d.set([...c, 255], (y * W + x) * 4); };
  [6, 8, 10, 8].forEach((w, c) => fill(c * 16 + (16 - w) / 2, 4, w, 12, [255, 0, 77]));
  [8, 12, 8, 8].forEach((w, c) => fill(c * 16 + (16 - w) / 2, 20, w, 12, [41, 173, 255]));
  return { width: W, height: H, data: d };
}

export default {
  skill: "import-sheet",
  fixture() {
    writePng(path, sheet());
    return fakeDocument({ width: 8, height: 8, layers: [{ name: "Layer 1", frames: [new Uint8Array(8 * 8 * 4)] }] });
  },
  steps: [{ tool: "import_sheet", input: { path, mode: "grid", cell_w: 16, cell_h: 16, row_tags: ["idle", "walk"] } }],
  check(fake, results, assert) {
    const s = fake.active.sprite;
    assert.deepEqual([s.width, s.height, s.durations.length], [16, 16, 8]);
    assert.deepEqual(s.tags.map((t) => [t.name, t.from, t.to]), [["idle", 1, 4], ["walk", 5, 8]]);
    const counts = fake.images(s.layers[0]).map(opaque);
    assert.deepEqual(counts, [6, 8, 10, 8, 8, 12, 8, 8].map((w) => w * 12), "each cell's shape lands in its frame");
  },
};
