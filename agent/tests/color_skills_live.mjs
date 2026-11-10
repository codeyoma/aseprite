// Live test of the color skills (#36, #38): extract a palette from an
// attached image, match one layer's tone to another, limit a sprite to a
// named palette. Run with Aseprite open:  node agent/tests/color_skills_live.mjs <ref.png> [claude|codex]
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const refPng = process.argv[2];
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
  while (Date.now() - t0 < 400_000) {
    await sleep(2500);
    if (!(await lua("return AsepriteAgent.isBusy()"))) break;
  }
  return lua("return AsepriteAgent.entries()");
}
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const header = (e) => e.filter((x) => x.kind === "header").at(-1)?.text;

// 1. Extract palette from an attached image.
await lua(`Sprite(16, 16, ColorMode.RGB) AsepriteAgent.attach{ path = ${JSON.stringify(refPng)} } return true`);
let e = await chat("/skill:extract-palette Get the palette of the attached image and set it as the sprite palette.");
const pal = await lua(`local p = app.sprite.palettes[1] local o = {} for i = 0, #p - 1 do local c = p:getColor(i) o[#o + 1] = string.format("%02x%02x%02x", c.red, c.green, c.blue) end return o`);
check("extract: header names the skill", header(e)?.endsWith("Extract palette"), header(e));
check("extract: sprite palette is the image's 4 colors", pal.length === 4 && ["1d2b53", "7e2553", "ffa300", "29adff"].every((h) => pal.includes(h)), pal);

// 2. Match the Enemy layer's tone to the Hero layer.
await lua(`local s = Sprite(16, 16, ColorMode.RGB) s.layers[1].name = "Hero"
  local function fill(layer, colors, y0)
    local img = Image(16, 16, ColorMode.RGB)
    for i, c in ipairs(colors) do for x = 0, 15 do img:drawPixel(x, y0 + i, c) end end
    s:newCel(layer, 1, img, Point(0, 0))
  end
  fill(s.layers[1], { Color(110, 80, 80), Color(85, 110, 90), Color(150, 140, 100) }, 0)
  local enemy = s:newLayer() enemy.name = "Enemy"
  fill(enemy, { Color(200, 20, 40), Color(40, 200, 60), Color(255, 220, 0) }, 6)
  return true`);
e = await chat("/skill:match-tone Make the Enemy layer match the Hero layer's muted, low-saturation mood, keeping its own hues. Skip variations.");
const stats = await c.call("color_stats", { source: "layer", layer: "Enemy", compare_to: { source: "layer", layer: "Hero" } });
const sat = [...textOf(stats).matchAll(/saturation ([0-9.]+)/g)].map((m) => +m[1]);
check("match: Enemy's saturation is within 60% of Hero's", sat.length === 2 && sat[0] / sat[1] < 1.6 && sat[0] / sat[1] > 0.6, textOf(stats));

// 3. Limit the sprite to PICO-8.
e = await chat("/skill:match-tone Limit the whole sprite to the PICO-8 palette.");
const cols = await c.call("palette_from_image", { max_colors: 256 });
const pico = ["000000","1d2b53","7e2553","008751","ab5236","5f574f","c2c3c7","fff1e8","ff004d","ffa300","ffec27","00e436","29adff","83769c","ff77a8","ffccaa"];
const used = [...textOf(cols).matchAll(/#([0-9a-f]{6})/g)].map((m) => m[1]);
check("remap: only PICO-8 colors remain", used.length > 0 && used.every((h) => pico.includes(h)), used);

console.log(failed ? `COLOR SKILLS TEST FAILED (${failed})` : "COLOR SKILLS TEST PASSED");
process.exit(failed ? 1 : 0);
