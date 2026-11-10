// Live test of Shade and outline (#39) on a flat sprite.
// Run with Aseprite open:  node agent/tests/shading_live.mjs [claude|codex]
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
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

await lua(`local s = Sprite(32, 32, ColorMode.RGB) s.layers[1].name = "Body"
  local img = Image(32, 32, ColorMode.RGB)
  for y = 0, 31 do for x = 0, 31 do if (x - 15.5) ^ 2 + (y - 15.5) ^ 2 < 100 then img:drawPixel(x, y, Color(60, 170, 80)) end end end
  s.layers[1]:cel(1).image = img return true`);
const headers = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length;
await lua(`AsepriteAgent.chat("/skill:shade-sprite Shade this flat sprite with light from the top left, 3 bands, and add a selout outline.", "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 400_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const e = await lua("return AsepriteAgent.entries()");
const header = e.filter((x) => x.kind === "header").at(-1)?.text ?? "";
check("the message ran with the skill", e.filter((x) => x.kind === "header").length > headers && /Shade and outline|shade-sprite/.test(header), header);
const s = await lua(`local s = app.sprite local o = {} for _, l in ipairs(s.layers) do o[#o + 1] = l.name .. (l.isVisible and "" or " (hidden)") end
  local img = Image(32, 32, ColorMode.RGB) img:drawSprite(s, 1)
  local function L(x, y) local v = img:getPixel(x, y) return app.pixelColor.rgbaR(v) * 0.3 + app.pixelColor.rgbaG(v) * 0.59 + app.pixelColor.rgbaB(v) * 0.11 end
  local edge = img:getPixel(15, 5)
  return { layers = o, tl = L(10, 10), br = L(21, 21), edgeA = app.pixelColor.rgbaA(edge), edgeL = L(15, 5) }`);
check("a shaded layer, original hidden", s.layers.some((n) => n.startsWith("AI: shaded")) && s.layers.some((n) => /Body \(hidden\)/.test(n)), s.layers);
check("lit from the top-left", s.tl > s.br + 20, s);
// The flat fill's luminance is 127: an outline pixel is clearly darker.
check("an outline around the shape", s.layers.some((n) => n.startsWith("AI:") && /outline/i.test(n)) && s.edgeA === 255 && s.edgeL < 112, s);
console.log(failed ? `SHADING TEST FAILED (${failed})` : "SHADING TEST PASSED");
process.exit(failed ? 1 : 0);
