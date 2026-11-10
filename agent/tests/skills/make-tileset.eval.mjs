// make-tileset: a 5-piece template becomes a 47-tile set, a preview map and
// Godot/Tiled exports.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDocument, textOf, tempDir } from "./_helpers.mjs";

const t = 8, dir = tempDir("make-tileset");
const GRASS = [60, 170, 80, 255], EDGE = [30, 110, 60, 255];
/** The autotile template: island, vertical, horizontal, fill, inner corners. */
function template() {
  const W = t * 5, d = new Uint8Array(W * t * 4);
  for (let i = 0; i < 5; i++) for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
    const l = x === 0, r = x === t - 1, tp = y === 0, b = y === t - 1;
    let c = GRASS;
    if (i === 0 && (l || r || tp || b)) c = EDGE;
    if (i === 1 && (l || r)) c = EDGE;
    if (i === 2 && (tp || b)) c = EDGE;
    if (i === 4 && (l || r) && (tp || b)) c = EDGE;
    d.set(c, (y * W + i * t + x) * 4);
  }
  return d;
}

export default {
  skill: "make-tileset",
  fixture: () => fakeDocument({ width: t * 5, height: t, layers: [{ name: "Template", frames: [template()] }] }),
  steps: [{ tool: "make_autotile", input: { layer: "Template", export_dir: dir } }],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /Made a 47-tile set of 8x8 tiles/);
    const [, set, preview] = fake.sprites;
    assert.ok(set && preview, "the set and a preview map are opened");
    assert.deepEqual([set.width, set.height], [64, 48], "47 tiles in 8 columns");
    assert.match(preview.title, /preview/);
    for (const f of ["terrain.png", "terrain.tres", "terrain.tsx", "terrain.json"]) assert.ok(existsSync(join(dir, f)), f);
    assert.equal(JSON.parse(readFileSync(join(dir, "terrain.json"), "utf8")).masks.length, 47);
    assert.equal((readFileSync(join(dir, "terrain.tsx"), "utf8").match(/<wangtile /g) ?? []).length, 47);
  },
};
