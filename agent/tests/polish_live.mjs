// Live test of the finishing tools (#64, #65): ambient occlusion and manual
// anti-aliasing on a shaded sprite, and sub-pixel motion for a slow bob.
// Run with Aseprite open:  node agent/tests/polish_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, done } = await live({ provider });
const layers = () => lua(`local o = {} for _, l in ipairs(app.sprite.layers) do o[#o + 1] = l.name end return o`);

// A dark-outlined body with a diagonal line-art stroke across it.
await lua(`local s = Sprite(24, 24, ColorMode.RGB) local img = Image(24, 24, ColorMode.RGB)
  for y = 3, 20 do for x = 3, 20 do img:drawPixel(x, y, Color(0xc0, 0x60, 0x30)) end end
  for y = 3, 20 do for x = 3, 20 do if x == 3 or y == 3 or x == 20 or y == 20 then img:drawPixel(x, y, Color(0x20, 0x10, 0x18)) end end end
  for i = 0, 12 do img:drawPixel(5 + i, 6 + (i // 2), Color(0x20, 0x10, 0x18)) img:drawPixel(5 + i, 7 + (i // 2), Color(0x20, 0x10, 0x18)) end
  s.layers[1].name = "Body" s:newCel(s.layers[1], 1, img, Point(0, 0)) return true`);
await chat("/skill:shade-sprite Add ambient occlusion and anti-alias the jagged diagonal stroke on Body. Don't reshade it.");
const names = await layers();
check("an ambient occlusion layer", names.some((n) => /^AI: ao/.test(n)), names);
check("an anti-alias layer", names.some((n) => /^AI: anti-alias/.test(n)), names);

// A small blob that should bob down by one pixel over 4 frames.
await lua(`local s = Sprite(12, 12, ColorMode.RGB) for i = 1, 4 do s:newFrame() end
  local img = Image(12, 12, ColorMode.RGB)
  for y = 4, 8 do for x = 4, 8 do img:drawPixel(x, y, Color(0x60, 0xb0, 0x60)) end end
  s.layers[1].name = "Slime" s:newCel(s.layers[1], 1, img, Point(0, 0)) return true`);
await chat("/skill:animate Make Slime sink by exactly 1 pixel from frame 1 to frame 5 in smooth sub-pixel steps (no whole-pixel jumps).");
const shades = await lua(`local s = app.sprite local out = {}
  for f = 2, 4 do local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, f)
    local seen, n = {}, 0
    for it in img:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 and not seen[v] then seen[v] = true n = n + 1 end end
    out[#out + 1] = n end return out`);
check("in-between frames use in-between shades", shades.some((n) => n >= 2), shades);
done("POLISH");
