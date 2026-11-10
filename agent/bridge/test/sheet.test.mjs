// Sprite sheet import (#41): grid, auto (sprites on a background), atlas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBackground, detectCells, findSprites, frameImages, gridFrames, parseAtlas, removeBackground, tagsFromRows } from "../dist/sheet.js";
import { findTool, runTool } from "../dist/tools.js";

function canvas(w, h, bg = [0, 0, 0, 0]) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(bg, i);
  return { width: w, height: h, data: d };
}
function rect(img, x, y, w, h, c) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) img.data.set([...c, 255], (j * img.width + i) * 4);
}
const RED = [255, 0, 77], BLUE = [41, 173, 255];

test("grid: cells found from the gutters, empty cells skipped, rows become tags", () => {
  // 4 columns x 2 rows of 16x16 cells; sprites of different widths, centered at the bottom.
  const img = canvas(64, 32);
  [6, 8, 10, 8].forEach((w, c) => rect(img, c * 16 + (16 - w) / 2, 4, w, 12, RED));
  [8, 12, 8].forEach((w, c) => rect(img, c * 16 + (16 - w) / 2, 20, w, 12, BLUE));
  const cells = detectCells(img);
  assert.deepEqual(cells, { cellW: 16, cellH: 16, marginX: 0, marginY: 0 });
  const frames = gridFrames(img, cells);
  assert.equal(frames.length, 7, "the empty last cell is skipped");
  assert.deepEqual(tagsFromRows(frames, ["idle", "walk"]), [{ name: "idle", from: 1, to: 4 }, { name: "walk", from: 5, to: 7 }]);
});

test("auto: sprites on a key color, nearby specks merged, reading order", () => {
  const img = canvas(60, 40, [255, 0, 255, 255]);
  rect(img, 2, 2, 10, 14, RED);
  rect(img, 13, 5, 1, 1, RED); // a speck 1px away joins the first sprite
  rect(img, 30, 4, 8, 12, BLUE);
  rect(img, 5, 24, 12, 10, BLUE);
  assert.deepEqual(detectBackground(img), { transparent: false, color: [255, 0, 255] });
  const clean = removeBackground(img);
  const sprites = findSprites(clean, 2);
  assert.deepEqual(sprites.map((s) => s.rect), [{ x: 2, y: 2, w: 12, h: 14 }, { x: 30, y: 4, w: 8, h: 12 }, { x: 5, y: 24, w: 12, h: 10 }]);
  assert.deepEqual(sprites.map((s) => s.row), [0, 0, 1]);
  const out = frameImages(clean, sprites, "bottom-center");
  assert.equal(out.width, 12);
  assert.equal(out.height, 14);
  // The 8x12 sprite sits on the bottom line, centered.
  const f2 = out.images[1];
  assert.equal(f2[((13) * 12 + 2) * 4 + 3], 255);
  assert.equal(f2[((1) * 12 + 2) * 4 + 3], 0);
});

test("atlas: Aseprite JSON with trimmed frames and tags", () => {
  const atlas = {
    frames: {
      "a 0.png": { frame: { x: 0, y: 0, w: 4, h: 6 }, rotated: false, trimmed: true, spriteSourceSize: { x: 2, y: 2, w: 4, h: 6 }, sourceSize: { w: 8, h: 8 }, duration: 120 },
      "a 1.png": { frame: { x: 4, y: 0, w: 8, h: 8 }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 }, sourceSize: { w: 8, h: 8 }, duration: 80 },
    },
    meta: { frameTags: [{ name: "blink", from: 0, to: 1, direction: "pingpong" }] },
  };
  const p = parseAtlas(atlas);
  assert.equal(p.width, 8);
  assert.deepEqual(p.frames[0], { rect: { x: 0, y: 0, w: 4, h: 6 }, offsetX: 2, offsetY: 2, duration: 120 });
  assert.deepEqual(p.tags, [{ name: "blink", from: 1, to: 2, direction: "pingpong" }]);
  assert.throws(() => parseAtlas({ frames: [{ frame: { x: 0, y: 0, w: 1, h: 1 }, rotated: true }] }), /rotated/);
});

test("import_sheet sends frames and tags to Aseprite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-"));
  const img = canvas(64, 32);
  [6, 8, 10, 8].forEach((w, c) => rect(img, c * 16 + (16 - w) / 2, 4, w, 12, RED));
  [8, 12, 8, 8].forEach((w, c) => rect(img, c * 16 + (16 - w) / 2, 20, w, 12, BLUE));
  const png = new PNG({ width: 64, height: 32 });
  png.data.set(img.data);
  writeFileSync(join(dir, "hero.png"), PNG.sync.write(png));
  const calls = [];
  const fake = { request: async (m, p) => { calls.push({ m, p }); return { result: { title: p.title } }; } };
  const r = await runTool(findTool("import_sheet"), { path: join(dir, "hero.png"), mode: "grid", row_tags: ["idle", "walk"] }, fake);
  const sent = calls[0].p;
  assert.equal(sent.frames.length, 8);
  assert.deepEqual([sent.width, sent.height], [16, 16]);
  assert.deepEqual(sent.tags.map((t) => t.name), ["idle", "walk"]);
  assert.match(r.content[0].text, /Imported 8 frames of 16x16 \(grid of 16x16 cells \(found from the gutters\)/);
  const auto = await runTool(findTool("import_sheet"), { path: join(dir, "hero.png") }, fake);
  assert.match(auto.content[0].text, /Imported 8 frames .*sprites found on the sheet/);
});

test("TexturePacker XML atlases: Sparrow/Starling and generic", async () => {
  const { parseAtlasXml } = await import("../dist/sheet.js");
  const sparrow = parseAtlasXml(`<?xml version="1.0"?><TextureAtlas imagePath="hero.png">
    <SubTexture name="idle0" x="0" y="0" width="10" height="12" frameX="-3" frameY="-4" frameWidth="16" frameHeight="16"/>
    <SubTexture name="idle1" x="10" y="0" width="16" height="16"/></TextureAtlas>`);
  assert.deepEqual(sparrow.frames.map((f) => [f.rect.x, f.rect.w, f.offsetX, f.offsetY]), [[0, 10, 3, 4], [10, 16, 0, 0]]);
  assert.deepEqual([sparrow.width, sparrow.height], [16, 16]);
  const generic = parseAtlasXml(`<TextureAtlas imagePath="a.png" width="64" height="32">
    <sprite n="a" x="2" y="3" w="8" h="9" oX="1" oY="2" oW="12" oH="12"/></TextureAtlas>`);
  assert.deepEqual([generic.frames[0].rect, generic.frames[0].offsetX, generic.width], [{ x: 2, y: 3, w: 8, h: 9 }, 1, 12]);
  assert.throws(() => parseAtlasXml(`<SubTexture name="r" x="0" y="0" width="4" height="4" rotated="true"/>`), /rotated/);
  assert.throws(() => parseAtlasXml("<TextureAtlas/>"), /no <SubTexture>/);
});

test("Godot SpriteFrames .tres round-trips with the exporter", async () => {
  const { parseGodotSpriteFrames, parseAtlasText } = await import("../dist/sheet.js");
  const { godotSpriteFrames } = await import("../dist/export.js");
  const placed = [
    { x: 0, y: 0, w: 16, h: 16, ox: 0, oy: 0, sw: 16, sh: 16 },
    { x: 16, y: 0, w: 10, h: 12, ox: 3, oy: 4, sw: 16, sh: 16 },
    { x: 32, y: 0, w: 16, h: 16, ox: 0, oy: 0, sw: 16, sh: 16 },
  ];
  const tres = godotSpriteFrames({
    name: "hero", image: "hero.png", placed, durations: [100, 200, 100], width: 48, height: 16, pivot: [0.5, 1],
    anims: [{ name: "idle", from: 0, to: 1, direction: "forward", loop: true }, { name: "jump", from: 2, to: 2, direction: "forward", loop: false }],
  }, "res://hero.png");
  const a = parseGodotSpriteFrames(tres);
  assert.deepEqual(a.frames.map((f) => [f.rect.x, f.rect.w, f.offsetX, f.offsetY, f.duration]), [[0, 16, 0, 0, 100], [16, 10, 3, 4, 200], [32, 16, 0, 0, 100]]);
  assert.deepEqual(a.tags, [{ name: "idle", from: 1, to: 2 }, { name: "jump", from: 3, to: 3 }]);
  assert.deepEqual([a.width, a.height], [16, 16]);
  assert.equal(parseAtlasText(tres, "x.tres").frames.length, 3);
});
