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

// Background and sprite detection as tools (#66).
import { fakeDocument } from "./helpers/fake_document.mjs";
import { readFileSync } from "node:fs";

const GRAY = [204, 204, 204], WHITE = [255, 255, 255];
/** A checkerboard of 4 px squares, shifted by 2 px (a cropped screenshot of a transparent image). */
function checkerboard(w, h) {
  const img = canvas(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    img.data.set([...((Math.floor((x + 2) / 4) + Math.floor((y + 1) / 4)) % 2 ? WHITE : GRAY), 255], (y * w + x) * 4);
  }
  return img;
}
const opaqueCount = (data) => { let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) n++; return n; };
function pngFile(img, name) {
  const dir = mkdtempSync(join(tmpdir(), "bg-"));
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(join(dir, name), PNG.sync.write(png));
  return join(dir, name);
}
/** Three sprites on a magenta key color: two in the first row, one below. */
function looseSheet() {
  const img = canvas(60, 40, [255, 0, 255, 255]);
  rect(img, 2, 2, 10, 14, RED);
  rect(img, 30, 6, 8, 10, BLUE);
  rect(img, 5, 24, 12, 10, BLUE);
  return img;
}

test("detectBackground: transparent, key color and checkerboard; removal keeps sprite pixels", async () => {
  const { describeBackground } = await import("../dist/sheet.js");
  const clear = canvas(20, 20);
  rect(clear, 5, 5, 4, 4, RED);
  assert.deepEqual(detectBackground(clear), { transparent: true });
  assert.equal(removeBackground(clear), clear, "nothing to remove");
  assert.equal(describeBackground(detectBackground(looseSheet())), "key color #ff00ff");

  const img = checkerboard(40, 30);
  rect(img, 10, 8, 12, 12, RED);
  rect(img, 14, 15, 2, 2, WHITE); // white inside the sprite, where the board would be gray, stays
  const bg = detectBackground(img);
  assert.deepEqual([bg.checker.cell, bg.checker.colors.map((c) => c.join()).sort()], [4, [GRAY.join(), WHITE.join()].sort()]);
  assert.match(describeBackground(bg), /^checkerboard (#cccccc\/#ffffff|#ffffff\/#cccccc) in 4 px squares$/);
  const clean = removeBackground(img, undefined, bg);
  assert.equal(opaqueCount(clean.data), 144, "only the 12x12 sprite is left");
  assert.deepEqual(findSprites(clean).map((s) => s.rect), [{ x: 10, y: 8, w: 12, h: 12 }]);
  // Two colors in plain stripes are not a checkerboard.
  const stripes = canvas(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) stripes.data.set([...(x < 16 ? GRAY : WHITE), 255], (y * 32 + x) * 4);
  assert.equal(detectBackground(stripes).checker, undefined);
});

test("detect_background: reports, writes a PNG without the key color, or puts the sprite on 'AI: no background'", async () => {
  const path = pngFile(looseSheet(), "sheet.png");
  const fake = fakeDocument({ width: 8, height: 8, layers: [{ name: "Layer 1", frames: [new Uint8Array(8 * 8 * 4)] }] });
  const tool = findTool("detect_background");
  assert.equal(tool.label({ remove: true }), "Remove background");
  const r = await runTool(tool, { path }, fake);
  assert.match(r.content[0].text, /^60x40 image: the background is key color #ff00ff, 86% of the pixels\.$/);
  assert.ok(!fake.calls.some((c) => c.method === "put_image"), "a report changes nothing");

  const w = await runTool(tool, { path, remove: true }, fake);
  const out = path.replace(/\.png$/, "-nobg.png");
  assert.match(w.content[0].text, new RegExp(`Wrote it with a transparent background to ${out}`));
  const png = PNG.sync.read(readFileSync(out));
  assert.equal(opaqueCount(png.data), 140 + 80 + 120);

  // A layer showing a checkerboard screenshot.
  const shot = checkerboard(40, 30);
  rect(shot, 10, 8, 12, 12, RED);
  const doc = fakeDocument({ width: 40, height: 30, layers: [{ name: "Shot", frames: [shot.data] }] });
  const d = await runTool(tool, { source: "layer", layer: "Shot", remove: true }, doc);
  assert.match(d.content[0].text, /checkerboard .* \(a screenshot of a transparent image\).* on 'AI: no background' \(the original is hidden\)/);
  assert.deepEqual(doc.layerNames(), ["Shot", "AI: no background"]);
  assert.equal(doc.active.sprite.layers[0].visible, false);
  assert.equal(opaqueCount(doc.cel("AI: no background")), 144);
});

test("find_sprites: boxes in reading order, cut into bottom-aligned frames or onto layers", async () => {
  const path = pngFile(looseSheet(), "loose.png");
  const tool = findTool("find_sprites");
  const fake = fakeDocument({ width: 60, height: 40, layers: [{ name: "Layer 1", frames: [new Uint8Array(60 * 40 * 4)] }] });
  const list = await runTool(tool, { path }, fake);
  assert.equal(list.content[0].text,
    "3 sprites in 2 rows on a key color #ff00ff background (similar sizes: they fit as frames of one animation):\n" +
    "row 1: 1: 2,2 10x14; 2: 30,6 8x10\nrow 2: 3: 5,24 12x10");
  assert.equal(fake.calls.length, 0, "a path source with as 'list' needs no Aseprite");

  // Layers: each sprite at its place on its own layer of the current sprite.
  const l = await runTool(tool, { path, as: "layers" }, fake);
  assert.match(l.content[0].text, /Cut onto 3 layers: AI: sprite 1, AI: sprite 2, AI: sprite 3\.$/);
  assert.deepEqual(fake.layerNames(), ["Layer 1", "AI: sprite 1", "AI: sprite 2", "AI: sprite 3"]);
  const s2 = fake.cel("AI: sprite 2");
  assert.equal(opaqueCount(s2), 80);
  assert.equal(s2[(6 * 60 + 30) * 4 + 3], 255, "sprite 2 keeps its place");
  assert.deepEqual([...s2.subarray((6 * 60 + 30) * 4, (6 * 60 + 30) * 4 + 3)], BLUE);

  // Frames: a new animation, one frame per sprite, bottom-aligned, rows as tags.
  const f = await runTool(tool, { path, as: "frames", row_tags: ["idle", "walk"], merge_distance: 1 }, fake);
  assert.match(f.content[0].text, /Opened "Sprites": 3 frames of 12x14, bottom-aligned, tags idle 1-2, walk 3-3\.$/);
  const anim = fake.active.sprite;
  assert.deepEqual([anim.width, anim.height, anim.durations.length], [12, 14, 3]);
  assert.deepEqual(anim.tags.map((t) => t.name), ["idle", "walk"]);
  assert.deepEqual(anim.palette.sort(), ["#29adff", "#ff004d"]);
  const f2 = fake.image(anim.layers[0], 2); // the 8x10 sprite, centered on the bottom line
  assert.equal(f2[(13 * 12 + 2) * 4 + 3], 255);
  assert.equal(f2[(3 * 12 + 2) * 4 + 3], 0);
  assert.equal(opaqueCount(f2), 80);

  // merge_distance joins a nearby speck; min_pixels drops it.
  const specked = looseSheet();
  rect(specked, 14, 4, 1, 1, RED);
  const p2 = pngFile(specked, "specked.png");
  assert.match((await runTool(tool, { path: p2, merge_distance: 2 }, fake)).content[0].text, /1: 2,2 13x14/);
  assert.match((await runTool(tool, { path: p2, merge_distance: 0, min_pixels: 2 }, fake)).content[0].text, /^3 sprites/);
  assert.match((await runTool(tool, { path: p2, merge_distance: 0, min_pixels: 1 }, fake)).content[0].text, /^4 sprites/);
});
