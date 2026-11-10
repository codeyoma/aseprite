// Live test of Recolor (#48) and Dithering: team color variants that keep
// the shading, and a dithered sky in the palette.
// Run with Aseprite open:  node agent/tests/recolor_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, done } = await live({ provider });

// A character with a 3-step blue shirt, skin and outline.
await lua(`local s = Sprite(16, 20, ColorMode.RGB) s.layers[1].name = "Hero"
  local img = Image(16, 20, ColorMode.RGB)
  for y = 1, 6 do for x = 5, 10 do img:drawPixel(x, y, Color(255, 204, 170)) end end
  local shirt = { Color(29, 43, 83), Color(41, 120, 255), Color(140, 200, 255) }
  for y = 7, 16 do for x = 4, 11 do img:drawPixel(x, y, shirt[(x < 6) and 1 or ((x > 9) and 3 or 2)]) end end
  for y = 1, 16 do img:drawPixel(4, y, Color(24, 20, 37)) img:drawPixel(11, y, Color(24, 20, 37)) end
  s.layers[1]:cel(1).image = img return true`);
await chat("/skill:recolor Make red team and green team versions of the Hero, recoloring only the blue shirt.");
// Variants as AI layers, or as a variations group to choose from (#25): search nested layers too.
const v = await lua(`local s = app.sprite local out = {}
  local function walk(layers) for _, l in ipairs(layers) do
    if l.isGroup then walk(l.layers)
    elseif l.name:match("^AI:") and l:cel(1) then
      local c = l:cel(1) local img = c.image local function at(x, y) local p = img:getPixel(x - c.position.x, y - c.position.y) return { app.pixelColor.rgbaR(p), app.pixelColor.rgbaG(p), app.pixelColor.rgbaB(p) } end
      out[#out + 1] = { name = l.name, dark = at(4 + 1, 10), mid = at(7, 10), light = at(10, 10), skin = at(7, 3) }
    end end end
  walk(s.layers) return out`);
const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
check("two variant layers", v.length >= 2, v.map((x) => x.name));
check("red and green variants", v.some((x) => x.mid[0] > x.mid[1] && x.mid[0] > x.mid[2]) && v.some((x) => x.mid[1] > x.mid[0] && x.mid[1] > x.mid[2]), v);
check("shading order kept", v.every((x) => lum(x.dark) < lum(x.mid) && lum(x.mid) < lum(x.light)), v);
check("skin unchanged", v.every((x) => x.skin.join() === "255,204,170"), v.map((x) => x.skin));

await lua(`local s = Sprite(32, 24, ColorMode.RGB)
  local p = Palette(4) p:setColor(0, Color(29, 43, 83)) p:setColor(1, Color(41, 120, 255)) p:setColor(2, Color(140, 200, 255)) p:setColor(3, Color(255, 241, 232))
  s:setPalette(p) s.selection = Selection(Rectangle(0, 0, 32, 16)) return true`);
await chat("/skill:dither Fill the selected sky with a vertical dithered gradient from the darkest blue at the top to the lightest blue at the bottom, using the palette.");
const d = await lua(`local s = app.sprite local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, 1)
  local seen, n = {}, 0
  for y = 0, 15 do for x = 0, 31 do local p = img:getPixel(x, y) if app.pixelColor.rgbaA(p) > 0 then
    local k = string.format("%02x%02x%02x", app.pixelColor.rgbaR(p), app.pixelColor.rgbaG(p), app.pixelColor.rgbaB(p)) if not seen[k] then seen[k] = 0 n = n + 1 end seen[k] = seen[k] + 1 end end end
  local mixed = 0 for y = 0, 15 do local a = img:getPixel(0, y) for x = 1, 31 do if img:getPixel(x, y) ~= a then mixed = mixed + 1 break end end end
  local o = {} for k in pairs(seen) do o[#o + 1] = k end
  local top, bottom = img:getPixel(0, 0), img:getPixel(0, 15)
  return { colors = o, rowsMixed = mixed, topDark = app.pixelColor.rgbaR(top) < 60, bottomLight = app.pixelColor.rgbaG(bottom) > 150 }`);
check("dither: only palette colors", d.colors.length >= 2 && d.colors.every((k) => ["1d2b53", "2978ff", "8cc8ff", "fff1e8"].includes(k)), d);
check("dither: mixed rows (a pattern, not bands) and dark at the top", d.rowsMixed >= 4 && d.topDark && d.bottomLight, d);
done("RECOLOR");
