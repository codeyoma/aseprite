// Live test of the review views (#75): a 4-frame bounce through the animate skill, which should look at the
// filmstrip before it reports; then snapshot's filmstrip and onion views called directly.
// Run with Aseprite open:  node agent/tests/filmstrip_live.mjs [claude|codex]
import { live } from "./live.mjs";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, ranSkill, done } = await live({ provider });

// A 32x32 sprite with a ball near the top, and its own palette (live fixtures never rely on the user's default).
const ball = `local s = Sprite(32, 32, ColorMode.RGB) s.layers[1].name = "Ball"
  local pal = Palette(4) pal:setColor(0, Color(0, 0, 0, 0)) pal:setColor(1, Color(24, 20, 37)) pal:setColor(2, Color(255, 0, 77)) pal:setColor(3, Color(255, 119, 168)) s:setPalette(pal)
  local img = Image(32, 32, ColorMode.RGB)
  for y = 4, 11 do for x = 12, 19 do img:drawPixel(x, y, Color(255, 0, 77)) end end
  img:drawPixel(14, 6, Color(255, 119, 168))
  s.layers[1]:cel(1).image = img return true`;

await lua(ball);
await chat("/skill:animate make a 4 frame bounce");
await ranSkill("animate");
const s = await lua(`local s = app.sprite return { frames = #s.frames, tags = #s.tags }`);
check("the bounce has frames", s.frames > 1, s);
soft("4 frames", s.frames === 4, s);
const steps = ((await lua("return AsepriteAgent.entries()")) ?? []).filter((e) => e.kind === "tool").map((e) => e.text ?? "");
// snapshot's step label for view filmstrip is "Look at the filmstrip".
soft("the agent looked at the filmstrip before it reported", steps.some((t) => /filmstrip/i.test(t)), steps);

// The views themselves (no model): a 4-frame tag on a 32x32 sprite.
await lua(`${ball.replace(/ return true$/, "")}
  local s = app.sprite
  for _ = 2, 4 do s:newFrame() end
  for f = 2, 4 do s.layers[1]:cel(f).position = Point(0, (f - 1) * 4) end
  local t = s:newTag(1, 4) t.name = "bounce" return true`);
const size = (r) => {
  const img = r.content?.find((x) => x.type === "image");
  if (!img) return undefined;
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  return [png.width, png.height];
};
const textOf = (r) => (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const strip = await c.call("snapshot", { view: "filmstrip", tag: "bounce" });
// 32 px frames: zoom 8 (256 px cells, 260 with the gap); 3 fit in 1024 px, so 4 frames wrap into 2 rows of 2:
// 4 + 2 * 260 = 524 wide, 4 + 2 * (13 + 256 + 4) = 550 high.
check("filmstrip: 2 rows of 2 frames at 8x", JSON.stringify(size(strip)) === "[524,550]", { size: size(strip), text: textOf(strip) });
check("filmstrip names the frames", /Filmstrip of frames 1-4 \(tag "bounce"\): 4 frames of 32x32 px at 8x/.test(textOf(strip)), textOf(strip));
const onion = await c.call("snapshot", { view: "onion", tag: "bounce", frame: 2 });
check("onion: one frame at 16x", JSON.stringify(size(onion)) === "[512,512]", { size: size(onion), text: textOf(onion) });
check("onion names its ghosts", /earlier frames \(1\) are ghosted in red and later frames \(3\) in blue/.test(textOf(onion)), textOf(onion));
const before = await lua(`return #app.sprite.frames`);
check("the views change nothing", before === 4, before);
done("FILMSTRIP");
