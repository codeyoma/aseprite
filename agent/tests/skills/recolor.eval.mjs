// recolor: a ramp from a base color, a palette-swapped variant layer, and a
// palette LUT for a shader.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { colorsOf, fakeDocument, PNG, rect, tempDir, textOf } from "./_helpers.mjs";

const dir = tempDir("recolor");
const BLUE = ["#1d2b53", "#29adff"], RED = ["#7e2553", "#ff004d"];
const variant = { name: "red", from: BLUE, to: RED };
function hero() {
  const d = rect(8, 8, [1, 1, 6, 6], [29, 43, 83]);
  d.set(rect(8, 8, [2, 2, 5, 3], [41, 173, 255]).subarray(2 * 8 * 4, 4 * 8 * 4), 2 * 8 * 4);
  return d;
}

export default {
  skill: "recolor",
  fixture: () => fakeDocument({ width: 8, height: 8, palette: BLUE, layers: [{ name: "Hero", frames: [hero()] }] }),
  steps: [
    { tool: "make_ramp", input: { base: "#ff004d", steps: 3 } },
    { tool: "palette_swap", input: { layer: "Hero", variants: [variant] } },
    { tool: "export_palette_lut", input: { layer: "Hero", dir, name: "hero", variants: [variant] } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /#ff004d/i, "the base stays in the ramp");
    assert.deepEqual([...colorsOf(fake.cel("Hero"))].sort(), BLUE, "the source is untouched");
    const red = fake.cel("AI: red");
    assert.deepEqual([...colorsOf(red)].sort(), RED);
    // Same shape, ramp steps matched by position.
    for (let i = 0; i < red.length; i += 4) assert.equal(red[i + 3], hero()[i + 3]);
    assert.equal("#" + [...red.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 3)].map((v) => v.toString(16).padStart(2, "0")).join(""), "#ff004d");
    for (const f of ["hero_index.png", "hero_lut.png", "hero_swap.gdshader"]) assert.ok(existsSync(join(dir, f)), f);
    const lut = PNG.sync.read(readFileSync(join(dir, "hero_lut.png")));
    // palette_swap added the 2 red shades to the sprite palette, so the base palette has 4 colors.
    assert.deepEqual([lut.width, lut.height], [4, 2], "4 palette colors x (base + 1 variant)");
    assert.match(textOf(results[2]), /Row 0 reproduces the sprite exactly/);
  },
};
