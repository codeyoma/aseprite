// Live test of Make a terrain tileset (#46): the agent draws the template
// and builds a 16x16 grass autotile set with exports.
// Run with Aseprite open:  node agent/tests/tileset_live.mjs <export dir> [claude|codex]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { lua, chat, check, done } = await live({ provider });

await lua(`Sprite(16, 16) return true`);
await chat(`/skill:make-tileset Make a 16x16 grass autotile set (47 tiles) and export it to ${dir} as grass.`);
const sprites = await lua(`local o = {} for _, s in ipairs(app.sprites) do o[#o + 1] = { title = app.fs.fileTitle(s.filename), w = s.width, h = s.height } end return o`);
const set = sprites.find((s) => /47-tile set/.test(s.title));
check("a 47-tile set of 16 px tiles", set && set.w === 128 && set.h === 96, sprites);
check("a preview map", sprites.some((s) => /preview/.test(s.title)), sprites);
const tm = await lua(`for _, s in ipairs(app.sprites) do if app.fs.fileTitle(s.filename):match("preview") then
  for _, l in ipairs(s.layers) do if l.isTilemap then return { tiles = #l.tileset } end end end end return {}`);
check("the preview is a tilemap layer using the set", tm.tiles === 48, tm);
check("exports written", ["png", "tres", "tsx", "json"].every((e) => existsSync(join(dir, `grass.${e}`))));
const json = existsSync(join(dir, "grass.json")) ? JSON.parse(readFileSync(join(dir, "grass.json"), "utf8")) : {};
check("bitmask map for every tile", json.masks?.length === 47, json.masks?.length);
done("TILESET");
