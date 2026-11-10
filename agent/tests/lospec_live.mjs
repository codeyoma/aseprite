// Live test of named palettes (#83), through the tools only (no model; fetches one palette from Lospec).
// Run with Aseprite open:  node agent/tests/lospec_live.mjs
import { live } from "./live.mjs";

const { c, lua, check, done } = await live({ provider: "claude" });
const text = (r) => r.content?.[0]?.text ?? "";
await lua(`local s = Sprite(8, 8, ColorMode.RGB) local img = Image(8, 8, ColorMode.RGB)
  for y = 0, 7 do for x = 0, 7 do img:drawPixel(x, y, Color(x * 32, y * 32, 128)) end end
  s.layers[1]:cel(1).image = img return true`);
const gb = await c.call("remap_to_palette", { palette: "gameboy" });
check("'gameboy' resolves (alias)", !gb.isError, text(gb).slice(0, 300));
const lp = await c.call("remap_to_palette", { palette: "lospec:endesga-32" });
check("lospec:endesga-32 is fetched and credited", !lp.isError && /lospec\.com/i.test(text(lp)) && /by /i.test(text(lp)), text(lp).slice(0, 400));
const list = text(await c.call("list_palettes", {}));
check("list_palettes shows the cached Lospec palette with credit", /endesga/i.test(list) && /lospec\.com/.test(list), list.slice(0, 600));
await lua(`app.sprite:close() return true`);
done("Lospec");
