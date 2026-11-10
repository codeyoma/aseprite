// Live test of Shade and outline (#39) on a flat sprite.
// Run with Aseprite open:  node agent/tests/shading_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

await lua(`local s = Sprite(32, 32, ColorMode.RGB) s.layers[1].name = "Body"
  local img = Image(32, 32, ColorMode.RGB)
  for y = 0, 31 do for x = 0, 31 do if (x - 15.5) ^ 2 + (y - 15.5) ^ 2 < 100 then img:drawPixel(x, y, Color(60, 170, 80)) end end end
  s.layers[1]:cel(1).image = img return true`);
await chat("/skill:shade-sprite Shade this flat sprite with light from the top left, 3 bands, and add a selout outline.");
await ranSkill("shade-sprite");
const s = await lua(`local s = app.sprite local o = {} for _, l in ipairs(s.layers) do o[#o + 1] = l.name .. (l.isVisible and "" or " (hidden)") end
  local img = Image(32, 32, ColorMode.RGB) img:drawSprite(s, 1)
  local function L(x, y) local v = img:getPixel(x, y) return app.pixelColor.rgbaR(v) * 0.3 + app.pixelColor.rgbaG(v) * 0.59 + app.pixelColor.rgbaB(v) * 0.11 end
  local edge = img:getPixel(15, 5)
  return { layers = o, tl = L(10, 10), br = L(21, 21), edgeA = app.pixelColor.rgbaA(edge), edgeL = L(15, 5) }`);
check("a new layer with the result", s.layers.length > 1, s.layers);
check("an outline pixel just outside the shape", s.edgeA === 255, s);
soft("a shaded layer, original hidden", s.layers.some((n) => n.startsWith("AI: shaded")) && s.layers.some((n) => /Body \(hidden\)/.test(n)), s.layers);
soft("lit from the top-left", s.tl > s.br + 20, s);
// The flat fill's luminance is 127: an outline pixel is clearly darker.
soft("an AI: outline layer, darker than the fill", s.layers.some((n) => n.startsWith("AI:") && /outline/i.test(n)) && s.edgeL < 112, s);
done("SHADING");
