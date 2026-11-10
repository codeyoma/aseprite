// Live test of Fix AI or upscaled pixel art (#37): attach an upscaled,
// noisy image and get a native-size sprite.
// Run with Aseprite open:  node agent/tests/pixel_snap_live.mjs <image.png> <width> <height> [claude|codex]
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const [img, w, h] = process.argv.slice(2, 5);
const provider = process.argv[5] ?? "claude";
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

await lua(`Sprite(16, 16) AsepriteAgent.attach{ path = ${JSON.stringify(img)} } return true`);
await lua(`AsepriteAgent.chat("/skill:fix-pixel-art This came out of an image generator. Make it real pixel art.", "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 400_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const s = await lua(`local s = app.sprite local n = {} local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, 1)
  for it in img:pixels() do if app.pixelColor.rgbaA(it()) > 0 then n[it()] = true end end
  local k = 0 for _ in pairs(n) do k = k + 1 end
  return { w = s.width, h = s.height, colors = k, title = app.fs.fileTitle(s.filename) }`);
check("a new sprite at the native size", Math.abs(s.w - +w) <= 1 && Math.abs(s.h - +h) <= 1, s);
check("a clean palette", s.colors <= 8, s);
const e = await lua("return AsepriteAgent.entries()");
check("it used the skill's tools", e.some((x) => x.kind === "tool" && /Fix pixel art/.test(x.text ?? "")), e.filter((x) => x.kind === "tool").map((x) => x.text));
console.log(failed ? `PIXEL SNAP TEST FAILED (${failed})` : "PIXEL SNAP TEST PASSED");
process.exit(failed ? 1 : 0);
