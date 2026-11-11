// Live test of fluid_fx (#106): a torch fire placed on a real sprite (one undo step, palette colors only, an FX
// record), then an agent asked for rising smoke.
// Run with Aseprite open:  node agent/tests/fluid_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

const setup = `local s = Sprite(64, 64, ColorMode.RGB) s.layers[1].name = "Wall"
  local img = Image(64, 64, ColorMode.RGB)
  for y = 40, 63 do for x = 28, 35 do img:drawPixel(x, y, Color(90, 60, 40)) end end
  s.layers[1]:cel(1).image = img return true`;
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {} }
  for _, l in ipairs(s.layers) do
    local n = 0 for _, cel in ipairs(l.cels) do if not cel.image:isEmpty() then n = n + 1 end end
    o.layers[#o.layers + 1] = { name = l.name, cels = n, fx = l.properties("aseprite-agent").fx ~= nil } end
  return o`);

await lua(setup);
const p = await c.call("fluid_fx", { preset: "torch" });
check("preview returns a contact sheet", !p.isError && p.content?.some((x) => x.type === "image"), p.content?.map((x) => x.text).join(" "));
const t0 = Date.now();
const r = await c.call("fluid_fx", { preset: "torch", apply: "layer", x: 32, y: 40 });
const ms = Date.now() - t0;
check("fluid_fx layer ran", !r.isError, r.content?.map((x) => x.text).join(" "));
const a = await info();
const fx = a.layers.find((l) => /^AI: fx fluid torch/.test(l.name));
check("an fx layer with art over several frames and an FX record", fx && fx.cels > 3 && fx.fx, a);
soft(`placed in under 5 s (${ms} ms)`, ms < 5000);
const k = await c.call("check_fx", {});
check("check_fx runs", !k.isError, k.content?.[0]?.text?.split("\n")[0]);
await lua(`app.command.Undo() return true`);
const b = await info();
check("one undo removes it", b.frames === 1 && !b.layers.some((l) => l.name.startsWith("AI: fx")), b);

await lua(setup);
await chat("Add looping smoke rising from the top of the Wall chimney (around x 32, y 40), then stop.", { timeout: 600_000 });
const d = await info();
soft("the agent used fluid_fx", d.layers.some((l) => /^AI: fx fluid/.test(l.name)), d.layers);
check("the sprite changed", d.layers.length > 1 || d.frames > 1, d);
done("FLUID");
