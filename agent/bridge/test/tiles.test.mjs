// Tilesets and autotiles (#46): masks, quarters, seams on a map, exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobMasks, buildTileset, cellMask, composeTile, godotTileset, makeSeamless, mapIndices, reduceMask, renderMap, seamScore, templateFrom2x3, tiledTileset, N, E, S, W, NE, NW, SE, SW } from "../dist/tiles.js";
import { fakeDocument } from "./helpers/fake_document.mjs";
import { SAMPLE_MAP } from "../dist/tile_tools.js";
import { findTool, runTool } from "../dist/tools.js";

const t = 8, GRASS = [60, 170, 80, 255], EDGE = [30, 110, 60, 255];
// Template: edge bands of 1 px where each piece has edges.
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
  return { width: W, height: t, data: d };
}
const isEdge = (img, x, y) => img.data[(y * img.width + x) * 4] === EDGE[0] && img.data[(y * img.width + x) * 4 + 3];

test("47 blob masks and 16 side-only masks", () => {
  assert.equal(blobMasks(47).length, 47);
  assert.equal(blobMasks(16).length, 16);
  assert.equal(reduceMask(NE), 0, "a corner without its sides doesn't count");
  assert.equal(reduceMask(N | E | NE), N | E | NE);
});

test("quarters: full mask is the fill tile, no neighbors the island", () => {
  const tpl = template();
  const full = composeTile(tpl, t, 255), none = composeTile(tpl, t, 0);
  const tileAt = (i) => { const o = new Uint8Array(t * t * 4); for (let y = 0; y < t; y++) o.set(tpl.data.subarray((y * tpl.width + i * t) * 4, (y * tpl.width + i * t + t) * 4), y * t * 4); return o; };
  assert.deepEqual(full, tileAt(3));
  assert.deepEqual(none, tileAt(0));
  // Inner corner in the NE quarter only.
  const nc = composeTile(tpl, t, N | E | S | W | NW | SE | SW);
  assert.ok(isEdge({ width: t, data: nc }, t - 1, 0) && !isEdge({ width: t, data: nc }, 0, 0));
});

test("a rendered map has edges only where terrain meets nothing", () => {
  const ts = buildTileset(template(), t, 47);
  const img = renderMap(ts, SAMPLE_MAP);
  const terrain = (px, py) => !!SAMPLE_MAP[Math.floor(py / t)]?.[Math.floor(px / t)];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!terrain(x, y)) continue;
    // A pixel whose 1 px neighborhood is all terrain cells is inside: no edge color.
    const inside = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].every(([dx, dy]) => terrain(x + dx, y + dy));
    if (inside) assert.ok(!isEdge(img, x, y), `edge inside at ${x},${y}`);
  }
  // And every terrain pixel next to empty space is edge.
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (terrain(x, y) && (!terrain(x + 1, y) || !terrain(x - 1, y) || !terrain(x, y + 1) || !terrain(x, y - 1))) assert.ok(isEdge(img, x, y), `missing edge at ${x},${y}`);
  }
  assert.equal(cellMask([[true, true], [true, false]], 0, 0), E | S);
});

test("Godot and Tiled exports describe every tile's neighbors", () => {
  const ts = buildTileset(template(), t, 47, 8);
  const tres = godotTileset(ts, "res://terrain.png");
  assert.equal((tres.match(/\/terrain_set = 0/g) ?? []).length, 47);
  const fullIndex = ts.masks.indexOf(255);
  const c = `${fullIndex % 8}:${Math.floor(fullIndex / 8)}/0`;
  assert.equal((tres.match(new RegExp(`^${c}/terrains_peering_bit/`, "gm")) ?? []).length, 8);
  assert.match(tres, /terrain_set_0\/mode = 0/);
  const tsx = tiledTileset(ts, "terrain.png");
  assert.equal((tsx.match(/<wangtile /g) ?? []).length, 47);
  assert.match(tsx, new RegExp(`<wangtile tileid="${fullIndex}" wangid="1,1,1,1,1,1,1,1"/>`));
  assert.match(tsx, /<wangtile tileid="0" wangid="0,0,0,0,0,0,0,0"\/>/);
});

test("seam score and the make_autotile tool", async () => {
  const tpl = template();
  assert.deepEqual(seamScore({ width: t, height: t, data: composeTile(tpl, t, 255) }), { horizontal: 0, vertical: 0 });
  const calls = [];
  const fake = { async request(m, p) { calls.push({ m, p }); return m === "snapshot" ? { result: { width: tpl.width, height: 16 }, binary: Buffer.concat([Buffer.from(tpl.data), Buffer.alloc(tpl.width * 8 * 4)]) } : { result: { title: p.title } }; } };
  const dir = mkdtempSync(join(tmpdir(), "tiles-"));
  const r = await runTool(findTool("make_autotile"), { export_dir: dir }, fake);
  const sprites = calls.filter((c) => c.m === "create_sprite" || c.m === "create_tilemap");
  assert.deepEqual(sprites.map((c) => c.m), ["create_sprite", "create_tilemap"], "the set and a tilemap preview");
  assert.deepEqual([sprites[0].p.width, sprites[0].p.height], [64, 48]);
  assert.match(r.content[0].text, /Made a 47-tile set of 8x8 tiles/);
  assert.equal(JSON.parse(readFileSync(join(dir, "terrain.json"), "utf8")).masks.length, 47);
  assert.match(readFileSync(join(dir, "terrain.tres"), "utf8"), /res:\/\/terrain\.png/);
});

// A 5-tile row whose every quarter has its own color.
function quarterRow(t) {
  const h = t / 2, W = 5 * t, d = new Uint8Array(W * t * 4);
  for (let p = 0; p < 5; p++) for (let q = 0; q < 4; q++) {
    const c = [40 + p * 40, 30 + q * 50, 200 - p * 30, 255];
    for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) d.set(c, ((Math.floor(q / 2) * h + y) * W + p * t + (q % 2) * h + x) * 4);
  }
  return { width: W, height: t, data: d };
}
// The same pieces laid out as the 2x3 (RPG Maker) template.
const PLACES = [[[0, 2], [3, 2], [0, 5], [3, 5]], [[0, 4], [3, 4], [0, 3], [3, 3]], [[2, 2], [1, 2], [2, 5], [1, 5]], [[2, 4], [1, 4], [2, 3], [1, 3]], [[2, 0], [3, 0], [2, 1], [3, 1]]];
function as2x3(row, t) {
  const h = t / 2, W = 2 * t, d = new Uint8Array(W * 3 * t * 4);
  PLACES.forEach((quarters, p) => quarters.forEach(([qx, qy], q) => {
    for (let y = 0; y < h; y++) {
      const src = ((Math.floor(q / 2) * h + y) * row.width + p * t + (q % 2) * h) * 4;
      d.set(row.data.subarray(src, src + h * 4), ((qy * h + y) * W + qx * h) * 4);
    }
  }));
  return { width: W, height: 3 * t, data: d };
}

test("a 6-tile (2x3) template builds the same 47 tiles pixel for pixel", () => {
  const t = 8, row = quarterRow(t);
  const a = buildTileset(row, t), b = buildTileset(templateFrom2x3(as2x3(row, t), t), t);
  assert.equal(a.masks.length, 47);
  assert.deepEqual(Buffer.from(b.image.data), Buffer.from(a.image.data));
  assert.throws(() => templateFrom2x3({ width: 8, height: 8, data: new Uint8Array(256) }, 8), /2 tiles wide and 3 high/);
});

test("map indices match the rendered map; neighbors' shared edges agree", () => {
  const t = 8, ts = buildTileset(quarterRow(t), t);
  const idx = mapIndices(ts, SAMPLE_MAP);
  const img = renderMap(ts, SAMPLE_MAP);
  for (let y = 0; y < SAMPLE_MAP.length; y++) for (let x = 0; x < SAMPLE_MAP[0].length; x++) {
    assert.equal(idx[y][x] >= 0, SAMPLE_MAP[y][x]);
    if (idx[y][x] < 0) continue;
    const i = idx[y][x], sx = (i % ts.columns) * t, sy = Math.floor(i / ts.columns) * t;
    const a = ((y * t) * img.width + x * t) * 4, b = (sy * ts.image.width + sx) * 4;
    assert.deepEqual([...img.data.subarray(a, a + 4)], [...ts.image.data.subarray(b, b + 4)]);
  }
});

test("make_seamless fixes small seams and leaves wide ones", () => {
  const w = 8, d = new Uint8Array(w * w * 4);
  for (let i = 0; i < d.length; i += 4) d.set([50, 150, 50, 255], i);
  d.set([250, 250, 250, 255], (3 * w + w - 1) * 4); // one clashing pixel on the right edge
  const fixed = makeSeamless({ width: w, height: w, data: d });
  assert.equal(fixed.fixed.horizontal, 1);
  assert.equal(seamScore(fixed.image).horizontal, 0);
  const stripes = new Uint8Array(d);
  for (let y = 0; y < w; y++) stripes.set([250, 0, 0, 255], (y * w + w - 1) * 4);
  const wide = makeSeamless({ width: w, height: w, data: stripes });
  assert.equal(wide.fixed.horizontal, 0);
  assert.equal(wide.tooWide.horizontal, 1);
});

test("make_autotile from a 2x3 layer opens the preview on a tilemap layer", async () => {
  const t = 8, tpl = as2x3(quarterRow(t), t);
  const full = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < tpl.height; y++) full.set(tpl.data.subarray(y * tpl.width * 4, (y + 1) * tpl.width * 4), y * 32 * 4);
  const fake = fakeDocument({ width: 32, height: 32, layers: [{ name: "Template", frames: [full] }] });
  const r = await runTool(findTool("make_autotile"), { layer: "Template" }, fake);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /6-tile \(2x3\)/);
  const tm = fake.calls.find((c) => c.method === "create_tilemap");
  assert.ok(tm, "a tilemap");
  assert.equal(tm.params.count, 47);
  assert.deepEqual(tm.params.map, mapIndices(buildTileset(quarterRow(t), t), SAMPLE_MAP));
});
