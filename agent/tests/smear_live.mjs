// Live test of smear (#105): sweep smears on a fast dash in a real sprite (one undo step, source hidden), then an
// agent asked for smear frames on the dash.
// Run with Aseprite open:  node agent/tests/smear_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

const setup = `local s = Sprite(96, 32, ColorMode.RGB) s.layers[1].name = "Ball"
  for i = 2, 4 do s:newFrame() end
  for f = 1, 4 do
    local img = Image(96, 32, ColorMode.RGB)
    local x0 = 6 + (f - 1) * 22
    for y = 10, 21 do for x = x0, x0 + 9 do img:drawPixel(x, y, Color(220, 80, 40)) end end
    for y = 10, 21 do img:drawPixel(x0 + 9, y, Color(120, 30, 20)) end
    s.layers[1]:cel(f).image = img
  end
  local t = s:newTag(1, 4) t.name = "dash" app.layer = s.layers[1] return true`;
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {} }
  for _, l in ipairs(s.layers) do
    local px = 0 for _, cel in ipairs(l.cels) do for it in cel.image:pixels() do if app.pixelColor.rgbaA(it()) > 0 then px = px + 1 end end end
    o.layers[#o.layers + 1] = { name = l.name, visible = l.isVisible, px = px } end
  return o`);

await lua(setup);
const r = await c.call("smear", { mode: "sweep", layer: "Ball", tag: "dash" });
check("smear ran", !r.isError, r.content?.map((x) => x.text).join(" "));
const a = await info();
const copy = a.layers.find((l) => l.name === "AI: smear Ball"), src = a.layers.find((l) => l.name === "Ball");
check("a copy layer, source hidden", copy && src && !src.visible, a.layers);
check("the smear adds pixels (trails)", copy && copy.px > src.px, a.layers);
check("no frames added", a.frames === 4, a.frames);
await lua(`app.command.Undo() return true`);
const b = await info();
check("one undo removes it", !b.layers.some((l) => l.name.startsWith("AI: smear")) && b.layers[0].visible, b);

await lua(setup);
await chat("The Ball dashes right in the 'dash' tag. Add smear frames to make it read as fast, then stop.", { timeout: 600_000 });
const d = await info();
soft("the agent used smear (a copy layer exists)", d.layers.some((l) => l.name === "AI: smear Ball"), d.layers);
check("the sprite changed", d.layers.length > 1 || d.frames !== 4, d);
done("SMEAR");
