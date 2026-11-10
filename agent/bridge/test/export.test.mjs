// Export for game engines (#49): packing, extrusion, and each preset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animFrames, godotSpriteFrames, jsonHash, pack, phaserAnims, unityMeta } from "../dist/export.js";
import { parseAtlas } from "../dist/sheet.js";
import { findTool, runTool } from "../dist/tools.js";

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
      if (m === "execute_lua") return { result: { ok: true, value: { durations: [100, 100, 200], tags: [{ name: "idle", from: 0, to: 2, dir: 0, repeats: 0 }], normal: "AI: normal Hero", title: "Hero" } } };
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
