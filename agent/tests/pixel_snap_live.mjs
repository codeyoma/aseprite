// Live test of Fix AI or upscaled pixel art (#37): attach an upscaled,
// noisy image and get a native-size sprite.
// Run with Aseprite open:  node agent/tests/pixel_snap_live.mjs <image.png> <width> <height> [claude|codex]
import { live } from "./live.mjs";

const [img, w, h] = process.argv.slice(2, 5);
const provider = process.argv[5] ?? "claude";
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

await lua(`Sprite(16, 16) AsepriteAgent.attach{ path = ${JSON.stringify(img)} } return true`);
await chat("/skill:fix-pixel-art This came out of an image generator. Make it real pixel art.");
await ranSkill("fix-pixel-art");
const s = await lua(`local s = app.sprite local n = {} local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, 1)
  for it in img:pixels() do if app.pixelColor.rgbaA(it()) > 0 then n[it()] = true end end
  local k = 0 for _ in pairs(n) do k = k + 1 end
  return { w = s.width, h = s.height, colors = k, title = app.fs.fileTitle(s.filename) }`);
check("a new sprite at the native size", Math.abs(s.w - +w) <= 1 && Math.abs(s.h - +h) <= 1, s);
soft("a clean palette (8 colors or fewer)", s.colors <= 8, s);
const e = await lua("return AsepriteAgent.entries()");
soft("it used the skill's tools", e.some((x) => x.kind === "tool" && /Fix pixel art/.test(x.text ?? "")), e.filter((x) => x.kind === "tool").map((x) => x.text));
done("PIXEL SNAP");
