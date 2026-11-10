// Live test of the FX library (#69): a hit spark added through the chat.
// Run with Aseprite open:  node agent/tests/fx_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

await lua(`local s = Sprite(64, 64, ColorMode.RGB) s.layers[1].name = "Hero"
  local img = Image(64, 64, ColorMode.RGB)
  for y = 40, 60 do for x = 26, 38 do img:drawPixel(x, y, Color(40, 90, 200)) end end
  s.layers[1]:cel(1).image = img
  local t = s:newTag(1, 1) t.name = "idle" return true`);
await chat("Add a hit spark effect centred at (32, 32), with its glow on a separate additive layer. Look at a preview first.");
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {}, tags = {} }
  for _, l in ipairs(s.layers) do o.layers[#o.layers + 1] = { name = l.name, blend = (l.blendMode == BlendMode.ADDITION) and "addition" or tostring(l.blendMode) } end
  for _, t in ipairs(s.tags) do o.tags[#o.tags + 1] = t.name .. " " .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber end
  local hero = 0 for _, c in ipairs(s.layers[1].cels) do if not c.image:isEmpty() then hero = hero + 1 end end
  o.hero = hero
  local fx = nil for _, l in ipairs(s.layers) do if l.name == "AI: fx hit-spark" then fx = l end end
  if fx then local last = fx:cel(#s.frames) o.lastEmpty = (not last) or last.image:isEmpty() end
  return o`);
const a = await info();
const fx = a.layers.find((l) => l.name === "AI: fx hit-spark");
const glow = a.layers.find((l) => /^AI: fx hit-spark glow/.test(l.name));
check("an AI: fx hit-spark layer", !!fx, a.layers);
check("frames were added for the effect", a.frames > 1, a.frames);
check("the hero is copied into the new frames", a.hero === a.frames, a);
check("the idle tag did not grow", a.tags.includes("idle 1-1"), a.tags);
check("the one-shot ends empty", a.lastEmpty === true, a);
soft("a glow layer with Addition blend", glow && glow.blend === "addition", glow ?? a.layers);
const k = await c.call("check", {});
check("check finds no errors", /\b0 errors\b/.test(k.content?.[0]?.text ?? ""), (k.content?.[0]?.text ?? "").split("\n")[0]);

// The tool itself (no model): add_fx is one undo step.
await lua(`local s = Sprite(64, 64, ColorMode.RGB) s.layers[1].name = "Hero" return true`);
await c.call("add_fx", { id: "hit-spark", x: 32, y: 32, glow: "layer" });
await lua(`app.command.Undo() return true`);
const b = await info();
check("one undo removes the effect and its frames", b.frames === 1 && !b.layers.some((l) => l.name.startsWith("AI: fx")), b);
done("FX");
