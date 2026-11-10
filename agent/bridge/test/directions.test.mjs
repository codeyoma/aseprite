// Directions (#43): tag directions, the mirror plan, isometric projection,
// and clean rotation for small angles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { directionPlan, isoGrid, isoProject, mirroredTagName, tagDirection } from "../dist/directions.js";
import { transform } from "../dist/animation.js";

test("tag names to directions", () => {
  assert.equal(tagDirection("walk_SE"), "SE");
  assert.equal(tagDirection("idle-north"), "N");
  assert.equal(tagDirection("run left"), "W");
  assert.equal(tagDirection("E"), "E");
  assert.equal(tagDirection("attack"), undefined);
});

test("plan: mirror what can be mirrored, draw the rest", () => {
  const p = directionPlan(["walk_S", "walk_E"], 8);
  assert.deepEqual(Object.keys(p.have).sort(), ["E", "S"]);
  assert.deepEqual(p.mirror, [{ from: "E", to: "W", tag: "walk_E" }]);
  assert.deepEqual(p.draw, ["SW", "NW", "N", "NE", "SE"]);
  assert.deepEqual(directionPlan(["S", "E"], 4).draw, ["N"]);
  assert.equal(mirroredTagName("walk_E", "E", "W"), "walk_W");
  assert.equal(mirroredTagName("idle-ne", "NE", "NW"), "idle-nw");
  assert.equal(mirroredTagName("hero", "", "W"), "hero_W");
});

test("isometric projection: 2:1 diamond, exact colors, corners in place", () => {
  const n = 8, d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) d.set(x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * n + x) * 4);
  d.set([0, 255, 0, 255], 0); // top-left corner green
  const iso = isoProject({ width: n, height: n, data: d });
  assert.deepEqual([iso.width, iso.height], [16, 8]);
  // The top-left source corner lands at the diamond's left... top point: (n-1..n, 0).
  const at = (x, y) => [...iso.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
  assert.deepEqual(at(7, 0), [0, 255, 0, 255]);
  const colors = new Set();
  for (let i = 0; i < iso.data.length; i += 4) if (iso.data[i + 3]) colors.add(iso.data.slice(i, i + 3).join());
  assert.deepEqual([...colors].sort(), ["0,0,255", "0,255,0", "255,0,0"]);
  assert.equal(at(0, 0)[3], 0, "outside the diamond stays transparent");
  const g = isoGrid(64, 32, 32);
  assert.equal(g.data[3], 90, "grid line through the origin");
});

test("RotSprite at 15 degrees keeps the palette and adds few orphan pixels", () => {
  const W = 40, d = new Uint8Array(W * W * 4);
  const put = (x, y, c) => d.set([...c, 255], (y * W + x) * 4);
  for (let y = 8; y < 32; y++) for (let x = 14; x < 26; x++) put(x, y, (x === 14 || x === 25 || y === 8 || y === 31) ? [24, 20, 37] : y < 16 ? [120, 220, 120] : [60, 170, 80]);
  const img = { width: W, height: W, data: d };
  const r = transform(img, { angle: 15 });
  const orphans = (im) => {
    let n = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!im.data[i + 3]) continue;
      const same = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const j = ((y + dy) * W + x + dx) * 4;
        return x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < W && im.data[j + 3] && im.data[j] === im.data[i] && im.data[j + 1] === im.data[i + 1] && im.data[j + 2] === im.data[i + 2];
      });
      if (!same) n++;
    }
    return n;
  };
  const colors = (im) => { const s = new Set(); for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3]) s.add(im.data.slice(i, i + 3).join()); return s; };
  for (const c of colors(r)) assert.ok(colors(img).has(c));
  assert.ok(orphans(r) <= 6, `${orphans(r)} orphans`);
});
