// Live test of juice (#104): the tool on a real sprite (one undo step, source hidden under the copy), then an agent
// asked for a squash on landing.
// Run with Aseprite open:  node agent/tests/juice_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

const setup = `local s = Sprite(48, 48, ColorMode.RGB) s.layers[1].name = "Slime"
  local bg = s:newLayer() bg.name = "BG" bg.stackIndex = 1
  local img = Image(48, 48, ColorMode.RGB)
  for y = 28, 44 do for x = 16, 31 do img:drawPixel(x, y, Color(60, 200, 90)) end end
  for x = 16, 31 do img:drawPixel(x, 44, Color(20, 90, 40)) end
  s.layers[2]:cel(1).image = img
  s:newFrame() s:newFrame()
  local t = s:newTag(1, 3) t.name = "idle" app.layer = s.layers[2] app.frame = s.frames[1] return true`;
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {}, tag = "" }
  for _, l in ipairs(s.layers) do
    local n = 0 for _, cel in ipairs(l.cels) do if not cel.image:isEmpty() then n = n + 1 end end
    o.layers[#o.layers + 1] = { name = l.name, visible = l.isVisible, cels = n } end
  for _, t in ipairs(s.tags) do o.tag = t.name .. " " .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber end
  return o`);

// The tool itself.
await lua(setup);
const r = await c.call("juice", { effect: "squash", layer: "Slime", frame: 1, frames: 5 });
check("juice ran", !r.isError, r.content?.map((x) => x.text).join(" "));
check("a contact sheet came back", r.content?.some((x) => x.type === "image"));
const a = await info();
const copy = a.layers.find((l) => l.name === "AI: juice Slime"), src = a.layers.find((l) => l.name === "Slime");
check("5 frames inserted", a.frames === 8, a.frames);
check("the copy layer has art in every frame", copy && copy.cels === 8, a.layers);
check("the source is hidden", src && !src.visible, a.layers);
check("the idle tag grew", a.tag === "idle 1-8", a.tag);
await lua(`app.command.Undo() return true`);
const b = await info();
check("one undo removes it all", b.frames === 3 && !b.layers.some((l) => l.name.startsWith("AI: juice")) && b.layers.find((l) => l.name === "Slime").visible, b);

// An agent asked in words.
await lua(setup);
await chat("The Slime lands on frame 1. Add a squash-and-stretch landing reaction right after it, then stop.", { timeout: 600_000 });
const d = await info();
soft("the agent used juice (a copy layer exists)", d.layers.some((l) => l.name === "AI: juice Slime"), d.layers);
check("frames were added after frame 1", d.frames > 3, d.frames);
done("JUICE");
