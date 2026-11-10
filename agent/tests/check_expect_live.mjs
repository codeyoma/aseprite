// Live test of check expectations (#80), through the tools only (no model).
// Run with Aseprite open:  node agent/tests/check_expect_live.mjs
import { live } from "./live.mjs";

const { c, lua, check, done } = await live({ provider: "claude" });
const text = (r) => r.content?.[0]?.text ?? "";
// Head on frames 1-3; the weapon crosses the head in frame 2 only; Fx should be on frame 3 but sits on frame 1.
await lua(`local s = Sprite(16, 16, ColorMode.RGB) s:newEmptyFrame() s:newEmptyFrame()
  local head = s.layers[1] head.name = "Head"
  local weapon = s:newLayer() weapon.name = "Weapon"
  local fx = s:newLayer() fx.name = "Fx"
  local function box(layer, f, x0, y0, x1, y1, c)
    local img = Image(16, 16, ColorMode.RGB)
    for y = y0, y1 do for x = x0, x1 do img:drawPixel(x, y, c) end end
    s:newCel(layer, f, img, Point(0, 0))
  end
  for f = 1, 3 do box(head, f, 4, 4, 7, 7, Color(200, 160, 120)) end
  box(weapon, 1, 10, 0, 11, 15, Color(150, 150, 160))
  box(weapon, 2, 5, 0, 6, 15, Color(150, 150, 160))
  box(weapon, 3, 12, 0, 13, 15, Color(150, 150, 160))
  box(fx, 1, 0, 0, 1, 1, Color(255, 255, 255))
  return true`);
const r = text(await c.call("check", { rules: ["empty-cel"], expect: { must_not_overlap: [["Weapon", "Head"]], layer_frames: { Fx: "3" } } }));
check("overlap found on frame 2 only", /Weapon \/ L\d+ Head, frame 2\]/.test(r) && !/Head, frame [13]\]/.test(r), r.slice(0, 600));
check("Fx art outside its frames and missing on frame 3", /Fx/.test(r) && /layer-frames|outside/i.test(r), r.slice(0, 600));
const bad = await c.call("check", { expect: { must_not_overlap: [["Weapon", "Nope"]] } });
check("an unknown layer is an error", bad.isError || /not found/i.test(text(bad)), text(bad).slice(0, 200));
await lua(`app.sprite:close() return true`);
done("Check expect");
