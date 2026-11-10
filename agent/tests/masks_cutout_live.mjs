// Live test of emission masks (#67) and cutting sprites out of a screenshot
// (#66). Run with Aseprite open:  node agent/tests/masks_cutout_live.mjs <scratch dir> [claude|codex]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

// A dark robot with two glowing cyan eyes.
await lua(`local s = Sprite(16, 16, ColorMode.RGB) local img = Image(16, 16, ColorMode.RGB)
  for y = 3, 13 do for x = 3, 12 do img:drawPixel(x, y, Color(0x40, 0x44, 0x50)) end end
  img:drawPixel(5, 6, Color(0x40, 0xf0, 0xff)) img:drawPixel(10, 6, Color(0x40, 0xf0, 0xff))
  s.layers[1].name = "Robot" s:newCel(s.layers[1], 1, img, Point(0, 0)) return true`);
await chat("/skill:normal-map Make an emission mask for Robot's glowing eyes (only the eyes glow).");
await ranSkill("normal-map");
const m = await lua(`local s = app.sprite for _, l in ipairs(s.layers) do if l.name:match("^AI: emission") then
  local cel = l:cel(1) local lit = 0
  for it in cel.image:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 and app.pixelColor.rgbaR(v) + app.pixelColor.rgbaG(v) + app.pixelColor.rgbaB(v) > 300 then lit = lit + 1 end end
  return { found = true, visible = l.isVisible, lit = lit } end end return { found = false }`);
check("an emission mask", m.found, m);
soft("it lights just the 2 eye pixels", m.found && m.lit === 2, m);

// A screenshot: three sprites on a solid blue background.
const W = 64, H = 24, png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H * 4; i += 4) png.data.set([60, 110, 200, 255], i);
const box = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) png.data.set([...c, 255], (y * W + x) * 4); };
box(4, 6, 10, 14, [230, 80, 60]);
box(24, 4, 12, 16, [80, 200, 90]);
box(46, 8, 9, 12, [240, 200, 60]);
const shot = join(dir, "shot.png");
writeFileSync(shot, PNG.sync.write(png));
await lua(`Sprite(16, 16) AsepriteAgent.attach{ path = ${JSON.stringify(shot)} } return true`);
await chat("/skill:recreate-from-reference Just cut the sprites out of this screenshot as frames of a new sprite, without recreating or restyling them.");
await ranSkill("recreate-from-reference");
const s = await lua(`local s = app.sprite return { frames = #s.frames, w = s.width, h = s.height }`);
check("three sprites cut out as frames", s.frames === 3, s);
soft("frames fit the largest sprite (12x16 or more)", s.w >= 12 && s.h >= 16, s);
done("MASKS CUTOUT");
