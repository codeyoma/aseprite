// Live test of Export for a game engine (#49).
// Run with Aseprite open:  node agent/tests/export_live.mjs <dir> <godot|unity> [claude|codex]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const [dir, engine] = process.argv.slice(2, 4);
const provider = process.argv[4] ?? "claude";
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
await lua(`local s = Sprite(16, 16, ColorMode.RGB) s.layers[1].name = "Slime" for i = 1, 3 do s:newFrame() end
  for f = 1, 4 do local img = Image(16, 16, ColorMode.RGB)
    for y = 8 + (f % 2), 15 do for x = 3, 12 do img:drawPixel(x, y, Color(60, 170, 80)) end end
    s.layers[1]:cel(f).image = img s.frames[f].duration = 0.12 end
  local a = s:newTag(1, 2) a.name = "idle" local b = s:newTag(3, 4) b.name = "hop" s.filename = "slime" return true`);
await lua(`AsepriteAgent.chat(${JSON.stringify(`/skill:export-game Export this slime for ${engine} to ${dir}.`)}, "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 600_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const files = existsSync(dir) ? readdirSync(dir) : [];
check("a sheet and JSON", files.some((f) => f.endsWith(".png") && !f.endsWith("_n.png")) && files.some((f) => f.endsWith(".json")), files);
const json = files.find((f) => f.endsWith(".json") && !f.includes("anims"));
const meta = json ? JSON.parse(readFileSync(join(dir, json), "utf8")) : {};
check("4 frames and the idle and hop tags", Object.keys(meta.frames ?? {}).length === 4 && meta.meta?.frameTags?.map((t) => t.name).sort().join() === "hop,idle", meta.meta);
if (engine === "godot") {
  const tres = files.find((f) => f.endsWith(".tres"));
  const body = tres ? readFileSync(join(dir, tres), "utf8") : "";
  check("Godot SpriteFrames with both animations", /&"idle"/.test(body) && /&"hop"/.test(body), files);
} else {
  const m = files.find((f) => f.endsWith(".png.meta"));
  const body = m ? readFileSync(join(dir, m), "utf8") : "";
  check("Unity meta with 4 point-filtered slices", (body.match(/- serializedVersion: 2\n      name:/g) ?? []).length === 4 && /filterMode: 0/.test(body), files);
}
check("import notes", files.includes("HOW_TO_IMPORT.txt"));
console.log(failed ? `EXPORT TEST FAILED (${failed})` : "EXPORT TEST PASSED");
process.exit(failed ? 1 : 0);
