// Live test of chat modes (#24) through the chat panel:
//  1. Ask mode: "make it blue" leaves the sprite unchanged.
//  2. Plan mode: a plan, no changes; then Apply plan carries it out.
// Run with Aseprite open:  node agent/tests/modes_live.mjs [claude|codex]
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(limit = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    await sleep(2000);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
  throw new Error("turn did not end");
}
const fingerprint = () =>
  lua(`local s = app.sprite
    local img = Image(s.width, s.height, ColorMode.RGB); img:drawSprite(s, 1)
    local n = 0 for it in img:pixels() do n = (n * 31 + it()) % 2147483647 end
    return { layers = #s.layers, hash = n }`);
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

await lua(`local s = Sprite(16, 16, ColorMode.RGB)
  app.useTool{ tool = "filled_rectangle", color = Color(255, 0, 0), points = { Point(4, 4), Point(11, 11) } }
  return true`);
const before = await fingerprint();

await lua(`AsepriteAgent.chat("Make the red square blue.", "${provider}", "ask") return true`);
await waitIdle();
check("ask mode leaves the sprite unchanged", JSON.stringify(await fingerprint()) === JSON.stringify(before));

await lua(`AsepriteAgent.chat("Add a new layer named Outline with a 1px black outline around the square.", "${provider}", "plan") return true`);
await waitIdle();
check("plan mode leaves the sprite unchanged", JSON.stringify(await fingerprint()) === JSON.stringify(before));
const entries = await lua("return AsepriteAgent.entries()");
const planText = entries.filter((e) => e.kind === "text").map((e) => e.text).at(-1) ?? "";
check("reply is a numbered plan", /(^|\n)\s*1[.)]/.test(planText), planText.slice(0, 200));
check("Apply plan offered", entries.at(-1)?.applyPlan === true, entries.at(-1));

await lua("return AsepriteAgent.applyPlan()");
await waitIdle();
const after = await fingerprint();
const names = await lua(`local o = {} for _, l in ipairs(app.sprite.layers) do o[#o + 1] = l.name end return o`);
check("Apply plan carried it out", names.includes("Outline") && after.hash !== before.hash, names);

console.log(failed ? `MODES TEST FAILED (${failed})` : "MODES TEST PASSED");
process.exit(failed ? 1 : 0);
