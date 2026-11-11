// Live test of fx_pipeline (#107): a dissolve with an outline glow over a layer in a real sprite (one undo step,
// source hidden, the pipeline stored on the layer), then an agent asked for a dissolve.
// Run with Aseprite open:  node agent/tests/pipeline_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

const setup = `local s = Sprite(48, 48, ColorMode.RGB) s.layers[1].name = "Ghost"
  local img = Image(48, 48, ColorMode.RGB)
  for y = 10, 40 do for x = 14, 33 do img:drawPixel(x, y, Color(120, 140, 230)) end end
  s.layers[1]:cel(1).image = img app.layer = s.layers[1] return true`;
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {} }
  for _, l in ipairs(s.layers) do
    local n = 0 for _, cel in ipairs(l.cels) do if not cel.image:isEmpty() then n = n + 1 end end
    o.layers[#o.layers + 1] = { name = l.name, visible = l.isVisible, cels = n, fx = l.properties("aseprite-agent").fx ~= nil } end
  return o`);

await lua(setup);
const pipeline = { name: "vanish", source: "Ghost", frames: 6, steps: [
  { type: "outline", mode: "outer", color: "#ffffff" },
  { type: "dissolve", threshold: { from: 0, to: 1 } },
] };
const p = await c.call("fx_pipeline", { pipeline, apply: "preview" });
check("preview returns a contact sheet", !p.isError && p.content?.some((x) => x.type === "image"), p.content?.map((x) => x.text).join(" "));
const r = await c.call("fx_pipeline", { pipeline, apply: "layer" });
check("fx_pipeline layer ran", !r.isError, r.content?.map((x) => x.text).join(" "));
const a = await info();
const fx = a.layers.find((l) => l.name === "AI: fx vanish"), src = a.layers.find((l) => l.name === "Ghost");
check("a copy with the record, source hidden", fx && fx.fx && src && !src.visible, a);
check("frames were inserted", a.frames === 7, a.frames);
await lua(`app.command.Undo() return true`);
const b = await info();
check("one undo removes it", b.frames === 1 && !b.layers.some((l) => l.name.startsWith("AI: fx")), b);

await lua(setup);
await chat("Make the Ghost dissolve away over a few frames after frame 1, then stop.", { timeout: 600_000 });
const d = await info();
soft("the agent used fx_pipeline", d.layers.some((l) => l.fx), d.layers);
check("frames were added", d.frames > 1, d.frames);
done("PIPELINE");
