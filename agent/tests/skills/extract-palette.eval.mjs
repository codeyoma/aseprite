// extract-palette: the colors of a reference PNG become the sprite palette
// (and a .gpl); remap_to_palette then pulls a layer onto it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colorsOf, fakeDocument, rect, tempDir, textOf, writePng } from "./_helpers.mjs";

const dir = tempDir("extract-palette");
const ref = join(dir, "ref.png"), gpl = join(dir, "ref.gpl");
const REF = [[255, 0, 77], [41, 173, 255], [0, 228, 54]];

export default {
  skill: "extract-palette",
  fixture() {
    const d = new Uint8Array(6 * 4 * 4);
    for (let i = 0; i < 24; i++) d.set([...REF[i % 3], 255], i * 4);
    writePng(ref, { width: 6, height: 4, data: d });
    // Near, not exact, versions of the reference colors.
    const art = rect(8, 8, [0, 0, 7, 2], [250, 10, 80]);
    art.set(rect(8, 8, [0, 3, 7, 5], [40, 170, 250]).subarray(3 * 8 * 4, 6 * 8 * 4), 3 * 8 * 4);
    art.set(rect(8, 8, [0, 6, 7, 7], [10, 220, 60]).subarray(6 * 8 * 4), 6 * 8 * 4);
    return fakeDocument({ width: 8, height: 8, layers: [{ name: "Art", frames: [art] }] });
  },
  steps: [
    { tool: "palette_from_image", input: { source: "file", path: ref, save_gpl: gpl, set_palette: true } },
    { tool: "remap_to_palette", input: { palette: "sprite", layer: "Art" } },
  ],
  check(fake, results, assert) {
    const want = ["#00e436", "#29adff", "#ff004d"];
    assert.match(textOf(results[0]), /3 distinct colors/);
    assert.deepEqual([...fake.active.sprite.palette].sort(), want, "the sprite palette is the reference's");
    const g = readFileSync(gpl, "utf8");
    assert.match(g, /^GIMP Palette/);
    for (const [r, gg, b] of REF) assert.match(g, new RegExp(`^\\s*${r}\\s+${gg}\\s+${b}`, "m"));
    assert.deepEqual([...colorsOf(fake.cel("Art"))].sort(), want, "the layer now uses only palette colors");
  },
};
