// Live test of Make a terrain tileset (#46): the agent draws the template
// and builds a 16x16 grass autotile set with exports.
// Run with Aseprite open:  node agent/tests/tileset_live.mjs <export dir> [claude|codex]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

await lua(`Sprite(16, 16) return true`);
await lua(`AsepriteAgent.chat(${JSON.stringify(`/skill:make-tileset Make a 16x16 grass autotile set (47 tiles) and export it to ${dir} as grass.`)}, "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 900_000) {
  await sleep(3000);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const sprites = await lua(`local o = {} for _, s in ipairs(app.sprites) do o[#o + 1] = { title = app.fs.fileTitle(s.filename), w = s.width, h = s.height } end return o`);
const set = sprites.find((s) => /47-tile set/.test(s.title));
check("a 47-tile set of 16 px tiles", set && set.w === 128 && set.h === 96, sprites);
check("a preview map", sprites.some((s) => /preview/.test(s.title)), sprites);
check("exports written", ["png", "tres", "tsx", "json"].every((e) => existsSync(join(dir, `grass.${e}`))));
const json = existsSync(join(dir, "grass.json")) ? JSON.parse(readFileSync(join(dir, "grass.json"), "utf8")) : {};
check("bitmask map for every tile", json.masks?.length === 47, json.masks?.length);
console.log(failed ? `TILESET TEST FAILED (${failed})` : "TILESET TEST PASSED");
process.exit(failed ? 1 : 0);
