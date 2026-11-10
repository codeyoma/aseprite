// Export for game engines (#49): packing, extrusion, and each preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animFrames, godotSpriteFrames, jsonHash, pack, phaserAnims, tiledTileset, unityMeta } from "../dist/export.js";
import { parseAtlas } from "../dist/sheet.js";
import { findTool, runTool } from "../dist/tools.js";
import { PNG } from "pngjs";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

function frame(w, h, x0, y0, x1, y1, c) {
  const d = new Uint8Array(w * h * 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([...c, 255], (y * w + x) * 4);
  return { width: w, height: h, data: d };
}
const frames = [frame(16, 16, 4, 6, 9, 15, [255, 0, 77]), frame(16, 16, 5, 5, 10, 15, [41, 173, 255]), frame(16, 16, 3, 8, 12, 15, [0, 228, 54])];
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test("pack: grid cells, trimming with offsets, extrusion", () => {
  const plain = pack(frames, { columns: 3 });
  assert.deepEqual([plain.sheet.width, plain.sheet.height], [48, 16]);
  assert.deepEqual(plain.placed[1], { x: 16, y: 0, w: 16, h: 16, ox: 0, oy: 0, sw: 16, sh: 16 });
  const trimmed = pack(frames, { columns: 3, trim: true, extrude: 1 });
  const p = trimmed.placed[0];
  assert.deepEqual([p.w, p.h, p.ox, p.oy], [6, 10, 4, 6]);
  // Extruded border repeats the edge pixel; padding keeps neighbors apart.
  assert.deepEqual(px(trimmed.sheet, p.x - 1, p.y), [255, 0, 77, 255]);
  assert.deepEqual(px(trimmed.sheet, p.x + p.w, p.y + p.h), [255, 0, 77, 255]);
  const q = trimmed.placed[1];
  assert.ok(q.x - 1 > p.x + p.w, "a gap between frames");
  assert.equal(pack(frames, { powerOfTwo: true }).sheet.width, 32);
  assert.equal(pack(frames, { scale: 2, columns: 3 }).sheet.width, 96);
});

const info = (placed, w, h) => ({
  name: "hero", image: "hero.png", placed, width: w, height: h, durations: [100, 100, 200], pivot: [0.5, 1],
  anims: [{ name: "idle", from: 0, to: 2, direction: "pingpong", loop: true }],
});

test("presets: JSON hash round-trips, Phaser, Godot and Unity metadata", () => {
  const { sheet, placed } = pack(frames, { columns: 3, trim: true });
  const s = info(placed, sheet.width, sheet.height);
  const atlas = parseAtlas(JSON.parse(jsonHash(s)));
  assert.equal(atlas.frames.length, 3);
  assert.deepEqual(atlas.frames[2], { rect: { x: placed[2].x, y: placed[2].y, w: 10, h: 8 }, offsetX: 3, offsetY: 8, duration: 200 });
  assert.deepEqual(atlas.tags, [{ name: "idle", from: 1, to: 3, direction: "pingpong" }]);
  assert.deepEqual(animFrames(s.anims[0]), [0, 1, 2, 1]);
  const ph = JSON.parse(phaserAnims(s, "hero"));
  assert.deepEqual(ph.anims[0].frames.map((f) => f.frame), ["hero 0", "hero 1", "hero 2", "hero 1"]);
  assert.equal(ph.anims[0].repeat, -1);
  const tres = godotSpriteFrames(s, "res://hero.png");
  assert.equal((tres.match(/type="AtlasTexture"/g) ?? []).length, 3);
  assert.match(tres, /"name": &"idle"/);
  assert.match(tres, /margin = Rect2\(4, 6, 10, 6\)/, "trimmed frames keep their place");
  assert.match(tres, /"duration": 1\.600/, "the 200 ms hold is a multiplier");
  const meta = unityMeta(s, 16);
  assert.equal((meta.match(/name: hero_\d/g) ?? []).length, 3);
  assert.match(meta, /filterMode: 0/);
  assert.match(meta, new RegExp(`y: ${sheet.height - placed[0].y - placed[0].h}\\n`), "y from the bottom");
});

test("export_for_engine writes the files for each engine", async () => {
  const fake = {
    async request(m, p) {
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Hero.aseprite", width: 16, height: 16, frames: [100, 100, 200].map((durationMs) => ({ durationMs })), layers: [{ id: "L2", name: "AI: normal Hero" }, { id: "L1", name: "Hero" }], tags: [{ name: "idle", from: 1, to: 3, direction: "forward", repeat: 0 }], palette: { colors: [] } } } };
      if (m === "snapshot") return { result: { width: 16, height: 16 }, binary: Buffer.from(frames[(p.frame ?? 1) - 1].data) };
      return { result: {} };
    },
  };
  for (const [engine, extra] of [["godot", "Hero.tres"], ["unity", "Hero.png.meta"], ["phaser", "Hero_anims.json"], ["tiled", "Hero.tsx"], ["json", "Hero.json"]]) {
    const dir = mkdtempSync(join(tmpdir(), `exp-${engine}-`));
    const r = await runTool(findTool("export_for_engine"), { engine, dir, trim: true, extrude: 1 }, fake);
    for (const f of ["Hero.png", "Hero_n.png", "Hero.json", extra, "HOW_TO_IMPORT.txt"]) assert.ok(existsSync(join(dir, f)), `${engine}: ${f}`);
    assert.match(r.content[0].text, new RegExp(`Exported 3 frames \\(1 animations\\) for ${engine}`));
  }
  const dir = mkdtempSync(join(tmpdir(), "exp-g-"));
  await runTool(findTool("export_for_engine"), { engine: "godot", dir }, fake);
  assert.match(readFileSync(join(dir, "HOW_TO_IMPORT.txt"), "utf8"), /Default Texture Filter = Nearest/);
});

test("Tiled tileset matches pack's grid with trim, padding and extrusion", () => {
  const img = (w, h, x0, y0, x1, y1) => { const d = new Uint8Array(w * h * 4); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d[(y * w + x) * 4 + 3] = 255; return { width: w, height: h, data: d }; };
  const frames = [img(8, 8, 1, 1, 5, 6), img(8, 8, 0, 0, 3, 7), img(8, 8, 2, 2, 7, 4)];
  const o = { trim: true, extrude: 1, columns: 2 };
  const { sheet, placed } = pack(frames, o);
  const tsx = tiledTileset("hero", placed, sheet.width, sheet.height, o);
  const attr = (k) => Number(tsx.match(new RegExp(` ${k}="(\\d+)"`))[1]);
  const [tw, th, sp, mg, cols] = ["tilewidth", "tileheight", "spacing", "margin", "columns"].map(attr);
  assert.equal(cols, 2);
  // Tiled's grid (margin + i * (tile + spacing)) lands on every placed frame.
  for (const [i, p] of placed.entries()) {
    assert.equal(mg + (i % cols) * (tw + sp), p.x);
    assert.equal(mg + Math.floor(i / cols) * (th + sp), p.y);
  }
});

test("9-patch slices: JSON slices, Unity border, Godot NinePatchRect", async () => {
  const { godotNinePatch, nineMargins } = await import("../dist/export.js");
  const placed = [{ x: 10, y: 20, w: 30, h: 16, ox: 1, oy: 2, sw: 32, sh: 20 }];
  const slices = [{ name: "button", bounds: { x: 0, y: 0, w: 32, h: 20 }, center: { x: 4, y: 5, w: 24, h: 10 } }];
  const s = { name: "ui", image: "ui.png", placed, durations: [100], anims: [], width: 64, height: 64, pivot: [0.5, 1], slices };
  assert.deepEqual(nineMargins(slices[0]), { left: 4, top: 5, right: 4, bottom: 5 });
  const meta = JSON.parse(jsonHash(s)).meta;
  assert.deepEqual(meta.slices[0].keys[0], { frame: 0, bounds: slices[0].bounds, center: slices[0].center });
  // Trimmed by (1, 2): the center leaves 3 px on each side of the 30x16 rect.
  assert.match(unityMeta(s), /border: \{x: 3, y: 3, z: 3, w: 3\}/);
  const scene = godotNinePatch(s, "res://ui.png");
  assert.match(scene, /type="NinePatchRect"/);
  assert.match(scene, /region_rect = Rect2\(9, 18, 32, 20\)/);
  assert.match(scene, /patch_margin_left = 4\npatch_margin_top = 5\npatch_margin_right = 4\npatch_margin_bottom = 5/);
  assert.equal(godotNinePatch({ ...s, slices: [] }, "x"), undefined);
});

// Effects (#71): pivot on the effect's origin, meta.fx, and the glow sheet, on the fake document.
const FX = { id: "spark", x: 4, y: 6, fps: 30, loop: false, windupMs: 33 };
/** An 8x8 effect sprite, 2 frames: 'AI: fx spark' (recorded) and its Addition glow; a hit on frame 2. */
function fxSprite({ hero = false } = {}) {
  return fakeDocument({
    title: "spark", width: 8, height: 8, durations: [33, 33], tags: [{ name: "spark", from: 1, to: 2 }],
    hits: [{ frame: 2, freezeMs: 80, shakeMs: 30, amp: 1 }],
    layers: [
      ...(hero ? [{ name: "Hero", frames: [rect(8, 8, [0, 7, 7, 7], [9, 9, 9]), rect(8, 8, [0, 7, 7, 7], [9, 9, 9])] }] : []),
      { name: "AI: fx spark", fx: FX, frames: [rect(8, 8, [3, 3, 4, 4], [255, 255, 0]), rect(8, 8, [2, 2, 5, 5], [255, 0, 0])] },
      { name: "AI: fx spark glow", blendMode: "addition", frames: [rect(8, 8, [1, 1, 6, 6], [0, 0, 255, 128]), rect(8, 8, [0, 0, 7, 7], [0, 0, 255, 64])] },
    ],
  });
}
const readPng = (f) => { const p = PNG.sync.read(readFileSync(f)); return { width: p.width, height: p.height, data: p.data }; };
const exportFx = async (input, fake = fxSprite()) => {
  const dir = mkdtempSync(join(tmpdir(), `exp-fx-${input.engine}-`));
  const r = await runTool(findTool("export_for_engine"), { dir, columns: 2, ...input }, fake);
  return { dir, r, json: JSON.parse(readFileSync(join(dir, "spark.json"), "utf8")), file: (f) => join(dir, f) };
};

/** The JSON snapshot every engine writes for the effect sprite (untrimmed, 2 columns). */
const FX_JSON = (pivot = { x: 0.5, y: 0.75 }) => ({
  frames: Object.fromEntries([0, 1].map((i) => [`spark ${i}`, {
    frame: { x: 8 * i, y: 0, w: 8, h: 8 }, rotated: false, trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 }, sourceSize: { w: 8, h: 8 }, duration: 33, pivot,
  }])),
  meta: {
    app: "aseprite-agent", image: "spark.png", glow: "spark_glow.png", format: "RGBA8888", size: { w: 16, h: 8 }, scale: "1",
    fx: { id: "spark", fps: 30, loop: false, windup: 33, origin: { x: 4, y: 6 }, hits: [{ frame: 1, freeze_ms: 80, shake_ms: 30, amp: 1 }] },
    frameTags: [{ name: "spark", from: 0, to: 1, direction: "forward" }],
    slices: [],
  },
});

test("effect export: JSON snapshots for Godot, Phaser and plain JSON (pivot on the origin, meta.fx, glow sheet)", async () => {
  for (const [engine, own] of [["godot", ["spark.tres", "spark_glow.tres"]], ["phaser", ["spark_anims.json"]], ["json", []]]) {
    const { r, json, file } = await exportFx({ engine });
    assert.ok(!r.isError, r.content[0].text);
    assert.deepEqual(json, FX_JSON(), engine);
    for (const f of ["spark.png", "spark_glow.png", ...own]) assert.ok(existsSync(file(f)), `${engine}: ${f}`);
    assert.match(r.content[0].text, /Pivot: the effect's origin \(4, 6 px\).*meta\.fx: spark, 30 fps, one-shot, windup 33 ms, 1 hit\..*Glow: AI: fx spark glow in spark_glow\.png/);
    const how = readFileSync(file("HOW_TO_IMPORT.txt"), "utf8");
    assert.match(how, /meta\.fx/);
    if (engine === "godot") {
      assert.match(readFileSync(file("spark_glow.tres"), "utf8"), /path="res:\/\/spark_glow\.png"/);
      assert.match(readFileSync(file("spark.tres"), "utf8"), /path="res:\/\/spark\.png"/);
      assert.match(how, /Offset to \(0, -2\)/, "a centered 8x8 sprite moved so the origin (4, 6) is the node");
    }
    if (engine === "phaser") assert.match(how, /load\.atlas\("spark_glow", "spark_glow\.png", "spark\.json"\)/);
  }
});

test("effect export: the color sheet leaves the light layers out; the glow sheet holds them at the same places", async () => {
  const { file } = await exportFx({ engine: "json" });
  const color = readPng(file("spark.png")), glow = readPng(file("spark_glow.png"));
  assert.deepEqual([glow.width, glow.height], [color.width, color.height]);
  assert.deepEqual(px(color, 3, 3), [255, 255, 0, 255]);
  assert.deepEqual(px(color, 1, 1), [0, 0, 0, 0], "no glow in the color sheet");
  assert.deepEqual(px(glow, 1, 1), [0, 0, 255, 128]);
  assert.deepEqual(px(glow, 3, 3), [0, 0, 255, 128], "the glow under the spark too");
  assert.deepEqual(px(glow, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(glow, 8, 0), [0, 0, 255, 64], "frame 2 at its place in the sheet");
  assert.deepEqual(px(color, 8 + 2, 2), [255, 0, 0, 255]);
  // Trimmed: one rect holds both, so placeLike keeps all of the glow.
  const t = await exportFx({ engine: "json", trim: true });
  assert.deepEqual(t.json.frames["spark 0"].spriteSourceSize, { x: 1, y: 1, w: 6, h: 6 });
  const tf = t.json.frames["spark 0"].frame, tg = readPng(t.file("spark_glow.png")), tc = readPng(t.file("spark.png"));
  assert.deepEqual(px(tg, tf.x, tf.y), [0, 0, 255, 128]);
  assert.deepEqual(px(tc, tf.x + 2, tf.y + 2), [255, 255, 0, 255]);
});

test("effect export: glow 'baked' composites the Addition layer into the color sheet and writes no glow sheet", async () => {
  const { json, file, r } = await exportFx({ engine: "json", glow: "baked" });
  assert.equal(existsSync(file("spark_glow.png")), false);
  assert.equal(json.meta.glow, undefined);
  assert.match(r.content[0].text, /baked into spark\.png/);
  const color = readPng(file("spark.png"));
  assert.deepEqual(px(color, 1, 1), [0, 0, 255, 128], "glow over nothing");
  const lit = px(color, 3, 3);
  assert.equal(lit[3], 255);
  assert.ok(lit[2] > 0 && lit[0] === 255 && lit[1] === 255, `the glow added to the spark (${lit})`);
});

test("effect export: an explicit pivot wins; a character with effects keeps the default pivot but gets meta.fx", async () => {
  const explicit = await exportFx({ engine: "json", pivot: "center" });
  assert.deepEqual(explicit.json, FX_JSON({ x: 0.5, y: 0.5 }));
  const mixed = await exportFx({ engine: "godot" }, fxSprite({ hero: true }));
  assert.equal(mixed.json.frames["spark 0"].pivot, undefined, "the default pivot is not written on frames");
  assert.deepEqual(mixed.json.meta.fx, FX_JSON().meta.fx);
  assert.doesNotMatch(readFileSync(mixed.file("HOW_TO_IMPORT.txt"), "utf8"), /Offset to/);
  // Without effects or hits, nothing changes: no meta.fx, no glow, no frame pivots.
  const plain = await exportFx({ engine: "json" }, fakeDocument({ title: "spark", width: 8, height: 8, layers: [{ name: "Hero", frames: [rect(8, 8, [1, 1, 2, 2], [9, 9, 9])] }] }));
  assert.equal(plain.json.meta.fx, undefined);
  assert.equal(plain.json.meta.glow, undefined);
  assert.equal(plain.json.frames["spark 0"].pivot, undefined);
});

test("effect export: fxExport finds light layers, pure effect sheets and several effects", async () => {
  const { fxExport } = await import("../dist/export_tools.js");
  const base = { title: "x", width: 10, height: 20, durations: [100], frame: 1, layer: "", layerId: "", tags: [], palette: [], slices: [], hits: [], colorMode: "rgb" };
  const L = (name, o = {}) => ({ id: name, name, visible: true, group: false, path: [], opacity: 255, blendMode: "normal", ...o });
  const two = fxExport({ ...base, layers: [
    L("AI: fx b", { fx: { id: "b", x: 5, y: 20, fps: 24, loop: true, windupMs: 0 } }),
    L("Screen", { blendMode: "screen" }),
    L("AI: fx a", { fx: { id: "a", x: 1, y: 2, fps: 30, loop: false, windupMs: 50 } }),
    L("Hidden", { visible: false }),
  ] }, 2);
  assert.deepEqual(two.light.map((l) => l.name), ["Screen"]);
  assert.equal(two.pure, true, "hidden layers don't count");
  assert.deepEqual(two.pivot, [0.5, 1], "the top effect's origin");
  assert.deepEqual(two.fx.origin, { x: 10, y: 40 }, "scaled");
  assert.deepEqual(two.fx.effects.map((e) => [e.id, e.layer]), [["b", "AI: fx b"], ["a", "AI: fx a"]]);
  // Layers in a hidden group are not shown; a glow layer by name counts as light even blending Normal.
  const grouped = fxExport({ ...base, layers: [
    L("G", { group: true, visible: false }), L("In G", { path: ["G"] }),
    L("AI: fx a glow"), L("AI: fx a", { fx: { id: "a", x: 0, y: 0, fps: 30, loop: false, windupMs: 0 } }),
  ] });
  assert.equal(grouped.pure, true);
  assert.deepEqual(grouped.light.map((l) => l.name), ["AI: fx a glow"]);
  assert.deepEqual(fxExport({ ...base, layers: [L("Hero")], hits: [{ frame: 3, freezeMs: 40 }] }).fx, { hits: [{ frame: 2, freeze_ms: 40 }] });
});

/**
 * Phaser 3's JSON Hash atlas parser (src/textures/parsers/JSONHash.js), reduced to the checks it makes and the
 * fields it reads: a frames object; each frame's rect cut from the image; trimmed frames' sourceSize and
 * spriteSourceSize; anchor or pivot as a custom origin.
 */
function phaserJsonHash(json, image) {
  assert.ok(json.frames && typeof json.frames === "object" && !Array.isArray(json.frames), "Invalid Texture Atlas JSON Hash");
  const out = {};
  for (const [key, src] of Object.entries(json.frames)) {
    const { x, y, w, h } = src.frame;
    for (const v of [x, y, w, h]) assert.ok(Number.isInteger(v), `${key}: integer frame rect`);
    assert.ok(x >= 0 && y >= 0 && x + w <= image.width && y + h <= image.height, `${key}: inside the image`);
    const f = { x, y, w, h, realWidth: w, realHeight: h };
    if (src.trimmed) {
      const ss = src.spriteSourceSize;
      assert.ok(src.sourceSize.w >= ss.x + ss.w && src.sourceSize.h >= ss.y + ss.h, `${key}: trim inside the source`);
      Object.assign(f, { realWidth: src.sourceSize.w, realHeight: src.sourceSize.h, trimX: ss.x, trimY: ss.y });
    }
    const pivot = src.anchor || src.pivot;
    if (pivot) Object.assign(f, { customPivot: true, pivotX: pivot.x, pivotY: pivot.y });
    out[key] = f;
  }
  return out;
}

test("Phaser atlas: the exported JSON has the shape Phaser's atlas loader reads, and the anims name its frames", async () => {
  for (const trim of [false, true]) {
    const { json, file } = await exportFx({ engine: "phaser", trim, extrude: trim ? 1 : 0 });
    assert.equal(typeof json.meta.image, "string");
    assert.ok(existsSync(file(json.meta.image)), "meta.image is the sheet next to it");
    const image = readPng(file(json.meta.image));
    assert.deepEqual(json.meta.size, { w: image.width, h: image.height });
    const frames = phaserJsonHash(json, image);
    assert.equal(Object.keys(frames).length, 2);
    for (const f of Object.values(frames)) {
      assert.equal(f.customPivot, true);
      // The origin in a frame's source pixels is the effect's origin.
      assert.deepEqual([f.pivotX * f.realWidth, f.pivotY * f.realHeight], [4, 6]);
    }
    // The glow atlas loads from the same JSON onto its own image.
    phaserJsonHash(json, readPng(file(json.meta.glow)));
    const anims = JSON.parse(readFileSync(file("spark_anims.json"), "utf8")).anims;
    assert.deepEqual(anims.map((a) => a.key), ["spark"]);
    for (const fr of anims[0].frames) assert.ok(frames[fr.frame], `${fr.frame} is an atlas frame`);
  }
});
