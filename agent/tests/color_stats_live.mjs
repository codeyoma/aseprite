// Live test of color_stats' hue mix, outline and ramps (#63): the agent
// describes a sprite's color structure. Run with Aseprite open:
//   node agent/tests/color_stats_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, soft, ranSkill, done } = await live({ provider });
await lua(`local s = Sprite(16, 16, ColorMode.RGB) local img = Image(16, 16, ColorMode.RGB)
  for y = 2, 13 do for x = 2, 13 do
    local ring = x == 2 or y == 2 or x == 13 or y == 13
    img:drawPixel(x, y, ring and Color(0x1a, 0x10, 0x30) or (y < 8 and Color(0xff, 0x8a, 0x30) or Color(0xc0, 0x50, 0x20)))
  end end
  s.layers[1].name = "Fox" s:newCel(s.layers[1], 1, img, Point(0, 0)) return true`);
await chat("/skill:match-tone Don't change anything. Tell me this sprite's outline color (hex), its main hues and how many steps its ramp has.");
await ranSkill("match-tone");
const reply = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").map((e) => e.text).join("\n");
const tools = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "tool").map((e) => e.text).join(" | ");
soft("it used color_stats", /tone|color/i.test(tools), tools);
soft("the reply names the outline color", /1a1030/i.test(reply), reply.slice(0, 300));
soft("the reply names orange as the main hue", /orange/i.test(reply), reply.slice(0, 300));
done("COLOR STATS");
