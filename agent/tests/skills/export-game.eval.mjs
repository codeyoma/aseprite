// export-game: a 3-frame tagged sprite exported for Godot and as JSON.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAtlas } from "../../bridge/dist/sheet.js";
import { fakeDocument, PNG, rect, tempDir } from "./_helpers.mjs";

const godot = tempDir("export-godot"), json = tempDir("export-json");

export default {
  skill: "export-game",
  fixture() {
    const fake = fakeDocument({
      width: 16, height: 16, frames: 3,
      layers: [{ name: "Hero", frames: [0, 1, 2].map((i) => rect(16, 16, [4, 6 - i, 11, 15], [41, 173, 255])) }],
      tags: [{ name: "idle", from: 1, to: 3 }],
    });
    fake.active.sprite.title = "Hero";
    return fake;
  },
  steps: [
    { tool: "export_for_engine", input: { engine: "godot", dir: godot } },
    { tool: "export_for_engine", input: { engine: "json", dir: json, trim: true } },
  ],
  check(fake, results, assert) {
    for (const f of ["Hero.png", "Hero.tres", "HOW_TO_IMPORT.txt"]) assert.ok(existsSync(join(godot, f)), `godot: ${f}`);
    const tres = readFileSync(join(godot, "Hero.tres"), "utf8");
    assert.match(tres, /"name": &"idle"/);
    assert.equal((tres.match(/type="AtlasTexture"/g) ?? []).length, 3);
    const raw = JSON.parse(readFileSync(join(json, "Hero.json"), "utf8"));
    const atlas = parseAtlas(raw);
    assert.equal(atlas.frames.length, 3);
    assert.deepEqual(atlas.tags.map((t) => [t.name, t.from, t.to]), [["idle", 1, 3]]);
    const sheet = PNG.sync.read(readFileSync(join(json, "Hero.png")));
    assert.deepEqual([sheet.width, sheet.height], [raw.meta.size.w, raw.meta.size.h], "the JSON describes the sheet it sits next to");
    // Trimmed frames keep their place in the 16x16 frame.
    assert.deepEqual(atlas.frames.map((f) => [f.rect.w, f.rect.h, f.offsetX, f.offsetY]), [[8, 10, 4, 6], [8, 11, 4, 5], [8, 12, 4, 4]]);
  },
};
