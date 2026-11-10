// Live test of Pixel text and UI (#50): a 3-state button and a panel in
// the sprite's palette, with 9-patch slices.
// Run with Aseprite open:  node agent/tests/ui_live.mjs [claude|codex]
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
const PICO = ["000000", "1d2b53", "7e2553", "008751", "ab5236", "5f574f", "c2c3c7", "fff1e8", "ff004d", "ffa300", "ffec27", "00e436", "29adff", "83769c", "ff77a8", "ffccaa"];
await lua(`local s = Sprite(64, 64, ColorMode.RGB) local p = Palette(16)
  local hx = { ${PICO.map((h) => `"${h}"`).join(", ")} }
  for i, h in ipairs(hx) do p:setColor(i - 1, Color(tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16))) end
  s:setPalette(p) return true`);
await lua(`AsepriteAgent.chat("/skill:make-ui Make a 'Play' button with normal, hover and pressed states and a small panel, using this sprite's palette.", "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 600_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const all = await lua(`local out = {}
  for _, s in ipairs(app.sprites) do
    local tags = {} for _, t in ipairs(s.tags) do tags[#tags + 1] = t.name end
    local nine = false for _, sl in ipairs(s.slices) do if sl.center then nine = true end end
    local seen, cols = {}, {}
    for f = 1, #s.frames do local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, f)
      for it in img:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 then local k = string.format("%02x%02x%02x", app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v)) if not seen[k] then seen[k] = true cols[#cols + 1] = k end end end end
    out[#out + 1] = { title = app.fs.fileTitle(s.filename), w = s.width, frames = #s.frames, tags = tags, nine = nine, colors = cols }
  end return out`);
const button = all.find((s) => s.frames >= 3 && s.tags.some((t) => /hover/i.test(t)) && s.tags.some((t) => /press/i.test(t)));
const panelS = all.find((s) => s !== button && s.nine && s.frames === 1);
check("a button with normal, hover and pressed frames", !!button, all.map((s) => [s.title, s.frames, s.tags]));
check("a panel", !!panelS, all.map((s) => [s.title, s.frames, s.nine]));
check("both have 9-patch slices", button?.nine && panelS?.nine, { button: button?.nine, panel: panelS?.nine });
const offPalette = [...(button?.colors ?? []), ...(panelS?.colors ?? [])].filter((h) => !PICO.includes(h));
check("in the sprite's palette", offPalette.length === 0, offPalette);
console.log(failed ? `UI TEST FAILED (${failed})` : "UI TEST PASSED");
process.exit(failed ? 1 : 0);
