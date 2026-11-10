// Live test of Recreate from a reference image (#40): a x3 screenshot of
// three poses on a solid background becomes an editable sprite, then a new
// character is drawn in its style.
// Run with Aseprite open:  node agent/tests/recreate_live.mjs <scratch dir> [claude|codex]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { c, lua, chat: send, waitIdle, check, soft, ranSkill, done } = await live({ provider });
// A turn that must reach the panel (a skill that needs an image refuses to send without one).
async function chat(prompt) {
  const headers = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length;
  await send(prompt, { wait: false });
  const sent = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length > headers;
  check(`sent: ${prompt.slice(0, 40)}…`, sent);
  if (sent) await waitIdle();
  if (sent) await ranSkill("recreate-from-reference");
}

// Three poses of a 16x16 outlined green blob with a 3-step ramp, on blue, scaled x3.
const OUT = [24, 20, 37], G = [[120, 220, 120], [60, 170, 80], [30, 110, 60]];
const W = 60, H = 24, S = 3, png = new PNG({ width: W * S, height: H * S });
for (let i = 0; i < png.data.length; i += 4) png.data.set([90, 140, 200, 255], i);
for (let p = 0; p < 3; p++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const r = Math.hypot(x - 7.5, y - 7.5);
  if (r > 7) continue;
  const col = r > 6 ? OUT : y < 6 ? G[0] : y > 10 ? G[2] : G[1];
  const px = x + 2 + p * 20, py = y + 4 - (p === 1 ? 1 : 0);
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) png.data.set([...col, 255], ((py * S + dy) * W * S + px * S + dx) * 4);
}
const shot = join(dir, "game_shot.png");
writeFileSync(shot, PNG.sync.write(png));

await lua(`Sprite(16, 16) AsepriteAgent.attach{ path = ${JSON.stringify(shot)} } return true`);
await chat("/skill:recreate-from-reference Recreate the character in this screenshot as an editable sprite.");
const s = await lua(`local s = app.sprite local o = {} for _, l in ipairs(s.layers) do o[#o + 1] = l.name end
  return { frames = #s.frames, w = s.width, h = s.height, palette = #s.palettes[1], layers = o, title = app.fs.fileTitle(s.filename) }`);
check("a sprite with the 3 poses as frames", s.frames === 3, s);
soft("at native size (14x14)", s.w === 14 && s.h === 14, s);
soft("palette of the reference's 4 colors", s.palette === 4, s);
soft("an Outline layer", s.layers.includes("Outline"), s);
const replies = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").map((e) => e.text).join(" ");
soft("the reply mentions the rights", /personal use|study|rights/i.test(replies), replies.slice(0, 300));

const before = await lua("return { n = #app.sprites, title = app.fs.fileTitle(app.sprite.filename) }");
await chat("/skill:recreate-from-reference Now draw a new character, a small mushroom, in exactly this style, in a new sprite.");
const colors = await lua(`local s = app.sprite local img = Image(s.width, s.height, ColorMode.RGB) local seen = {} local n = 0
  for _, l in ipairs(s.layers) do if l.isImage and l.isVisible then local c = l:cel(1) if c then img:drawImage(c.image, c.position) end end end
  for it in img:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 then local k = string.format("%02x%02x%02x", app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v)) if not seen[k] then seen[k] = true n = n + 1 end end end
  local o = {} for k in pairs(seen) do o[#o + 1] = k end return { n = n, colors = o, w = s.width, h = s.height }`);
const allowed = ["181425", "78dc78", "3caa50", "1e6e3c"];
const after = await lua("return { n = #app.sprites, title = app.fs.fileTitle(app.sprite.filename) }");
check("the new art is in a new sprite", after.n > before.n && after.title !== before.title, { before, after });
check("the new sprite has art", colors.n > 0, colors);
soft("new art uses only the reference's colors", colors.colors.every((h) => allowed.includes(h)), colors);
soft("new art at a similar size", colors.w <= 32 && colors.h <= 32, colors);

done("RECREATE");
