// Live test of AI layers and variations (#25) through the chat panel.
// Run with Aseprite open:  node agent/tests/variations_live.mjs [claude|codex]
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
async function chat(prompt) {
  await lua(`AsepriteAgent.chat(${JSON.stringify(prompt)}, "${provider}", "agent") return true`);
  const t0 = Date.now();
  while (Date.now() - t0 < 400_000) {
    await sleep(2000);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
  throw new Error("turn did not end");
}
const layers = () => lua(`local o = {} for _, l in ipairs(app.sprite.layers) do o[#o + 1] = l.name end return o`);
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

await lua(`local s = Sprite(32, 32, ColorMode.RGB); s.layers[1].name = "Hero"
  app.useTool{ tool = "filled_rectangle", color = Color(200, 60, 60), points = { Point(12, 8), Point(19, 22) } }
  return true`);

await chat("Add a small dark shadow under the red figure. Skip the check.");
let names = await layers();
check("generated content lands on an AI: layer", names.some((n) => n.startsWith("AI: ")) && names.includes("Hero"), names);

const before = await layers();
await chat("Give me 3 variations of a tiny 5px-tall sword next to the figure, each in a different color. Skip the check.");
let entries = await lua("return AsepriteAgent.entries()");
const v = entries.filter((e) => e.kind === "variations").at(-1);
check("3 variations shown", v && v.count === 3, v);
await lua("return AsepriteAgent.pickVariation(2)");
names = await layers();
const added = names.filter((n) => !before.includes(n));
check("picking leaves exactly one new layer", added.length === 1 && added[0].startsWith("AI: ") && !names.some((n) => n.startsWith("AI variations")), names);
const prompt = await lua(`for _, l in ipairs(app.sprite.layers) do if l.name == ${JSON.stringify(added[0] ?? "")} then return l.properties("aseprite-agent").prompt end end`);
check("prompt stored on the kept layer", typeof prompt === "string" && /variations/.test(prompt), prompt);

const before2 = await layers();
await chat("Give me 2 variations of a small yellow star above the figure. Skip the check.");
entries = await lua("return AsepriteAgent.entries()");
check("2 variations shown", entries.filter((e) => e.kind === "variations").at(-1)?.count === 2);
await lua("return AsepriteAgent.discardVariations()");
check("discard leaves the layers unchanged", JSON.stringify(await layers()) === JSON.stringify(before2), await layers());

console.log(failed ? `VARIATIONS TEST FAILED (${failed})` : "VARIATIONS TEST PASSED");
process.exit(failed ? 1 : 0);
