// Live test of importing an animated file as frames: the panel's "Import
// animation as frames" (no agent turn) into a new sprite and onto a layer,
// then the agent doing it from an attached GIF.
// Run with Aseprite open:  node agent/tests/import_animation_live.mjs <scratch dir> [claude|codex]
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { lua, chat, check, soft, done } = await live({ provider });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 6-frame 24x24 GIF: a red square moving right, the last frame held 400 ms.
const gif = join(dir, "ball.gif");
await lua(`
  local s = Sprite(24, 24, ColorMode.RGB)
  for f = 1, 6 do
    if f > 1 then s:newEmptyFrame() end
    local img = Image(24, 24, ColorMode.RGB)
    for y = 8, 15 do for x = 1 + (f - 1) * 3, 8 + (f - 1) * 3 do img:drawPixel(x, y, Color(220, 40, 40)) end end
    s:newCel(s.layers[1], f, img, Point(0, 0))
    s.frames[f].duration = f == 6 and 0.4 or 0.1
  end
  s:saveCopyAs(${JSON.stringify(gif)})
  s:close()
  return true`);

const sprite = `local s = app.sprite if not s then return { layers = {}, durations = {} } end local d, names = {}, {}
  for i, f in ipairs(s.frames) do d[i] = math.floor(f.duration * 1000 + 0.5) end
  for _, l in ipairs(s.layers) do names[#names + 1] = l.name end
  return { title = app.fs.fileTitle(s.filename), w = s.width, h = s.height, durations = d, layers = names }`;
const until = async (cond) => { for (let i = 0; i < 40; i++) { const v = await lua(sprite); if (cond(v)) return v; await sleep(250); } return lua(sprite); };

// 1) Panel action, into a new sprite.
await lua(`AsepriteAgent.importAnimation{ path = ${JSON.stringify(gif)}, into = "new" } return true`);
const a = await until((v) => v.title === "ball");
check("a new sprite 'ball' with 6 frames and the GIF's timing",
  a.title === "ball" && a.w === 24 && a.durations.join() === "100,100,100,100,100,400", a);

// 2) Panel action, onto a layer of a 32x32 sprite with 2 frames, from frame 2.
await lua(`local s = Sprite(32, 32) s:newEmptyFrame() app.frame = s.frames[1]
  AsepriteAgent.importAnimation{ path = ${JSON.stringify(gif)}, into = "layer", frame = 2 } return true`);
const b = await until((v) => v.layers.includes("AI: ball"));
check("layer 'AI: ball' from frame 2, frames added to 7, timing kept",
  b.layers.includes("AI: ball") && b.durations.join() === "100,100,100,100,100,100,400", b);
const cel = await lua(`local l for _, x in ipairs(app.sprite.layers) do if x.name == "AI: ball" then l = x end end
  local c = l and l:cel(2) return c and { x = c.position.x, y = c.position.y } or {}`);
check("the frames are centered (4,4)", cel.x === 4 && cel.y === 4, cel);

// 3) The agent, from an attached GIF.
await lua(`local s = Sprite(32, 32)
  AsepriteAgent.clearAttachments()
  AsepriteAgent.attach{ path = ${JSON.stringify(gif)} }
  return true`);
await chat("Put the attached GIF's frames into this sprite as they are, keeping its timing.");
const c = await lua(sprite);
check("the agent put the GIF's 6 frames into the sprite", c.durations.length === 6, c);
soft("with the GIF's timing", c.durations.join() === "100,100,100,100,100,400", c);
done("IMPORT ANIMATION");
