// Live test of 3D model to pixel sprites (#44).
// Run with Aseprite open:  node agent/tests/model_live.mjs <dir> [claude|codex]
import { join } from "node:path";
import { makeRobot } from "../bridge/test/helpers/glb.mjs";
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
async function chat(prompt) {
  await lua(`AsepriteAgent.chat(${JSON.stringify(prompt)}, "${provider}", "agent") return true`);
  const t0 = Date.now();
  while (Date.now() - t0 < 500_000) {
    await sleep(2500);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
}
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const path = join(dir, "robot.glb");
makeRobot(path);

await chat(`/skill:model-to-sprites Render the robot model at ${path} as a 32px character in 8 directions with its wave animation, PICO-8 palette.`);
const a = await lua(`local s = app.sprite local o = {} for _, t in ipairs(s.tags) do o[#o + 1] = t.name end
  local cols = {} local img = Image(s.spec) img:drawSprite(s, 1)
  for p in img:pixels() do local v = p() if app.pixelColor.rgbaA(v) > 0 then cols[v] = true end end
  local n = 0 for _ in pairs(cols) do n = n + 1 end
  return { frames = #s.frames, tags = o, w = s.width, h = s.height, colors = n }`);
const dirs = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
check("8 direction tags for the wave clip", dirs.every((d) => a.tags.some((t) => t === `wave_${d}` || t === d)), a.tags);
check("32x32 frames, several per direction", a.w === 32 && a.h === 32 && a.frames >= 16, a);
check("few colors (palette snapped)", a.colors > 2 && a.colors <= 16, a.colors);
console.log(failed ? `MODEL TEST FAILED (${failed})` : "MODEL TEST PASSED");
process.exit(failed ? 1 : 0);
