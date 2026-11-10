// Live test of the FX overlay and hit-stop (#70): a slash on a 6-frame attack with a 120 ms hit-stop,
// through the chat, then fx_overlay and hit_stop called directly (one undo step each).
// Run with Aseprite open:  node agent/tests/fx_overlay_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

// A 64x64 sprite: a Hero rectangle that winds up (left), lunges (right) and recovers over 6 frames of 100 ms,
// tagged `attack`.
const attack = `local s = Sprite(64, 64, ColorMode.RGB) s.layers[1].name = "Hero"
  for _ = 2, 6 do s:newEmptyFrame() end
  local xs = { 18, 16, 20, 28, 26, 22 }
  for f = 1, 6 do
    s.frames[f].duration = 0.1
    local img = Image(64, 64, ColorMode.RGB)
    for y = 34, 54 do for x = xs[f], xs[f] + 9 do img:drawPixel(x, y, Color(40, 90, 200)) end end
    s:newCel(s.layers[1], f, img, Point(0, 0))
  end
  local t = s:newTag(1, 6) t.name = "attack"
  app.frame = s.frames[1] return true`;
const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, total = 0, layers = {}, tags = {}, hits = {}, links = 0 }
  for _, f in ipairs(s.frames) do o.total = o.total + math.floor(f.duration * 1000 + 0.5) end
  for _, l in ipairs(s.layers) do o.layers[#o.layers + 1] = l.name end
  for _, t in ipairs(s.tags) do o.tags[#o.tags + 1] = t.name .. " " .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber end
  for _, h in ipairs(s.properties("aseprite-agent")["fx.hits"] or {}) do o.hits[#o.hits + 1] = { frame = h.frame, freezeMs = h.freezeMs } end
  local hero = s.layers[1]
  for f = 2, #s.frames do local a, b = hero:cel(f - 1), hero:cel(f) if a and b and a.image.id == b.image.id then o.links = o.links + 1 end end
  return o`);
const step = Math.round(1000 / 30);
// An empty Lua table may come back as {}.
const hitsOf = (o) => (Array.isArray(o.hits) ? o.hits : []);

await lua(attack);
const before = await info();
await chat("Add a slash effect to the attack, hitting on frame 4, with a 120 ms hit-stop");
const a = await info();
const fxLayer = a.layers.find((n) => /^AI: fx /.test(n));
check("an AI: fx layer exists", !!fxLayer, a.layers);
// fx_overlay with the tag cuts or retimes inside it, so only the hit-stop changes the total; extending past the
// tag (overflow 'extend') would add whole effect frames, which this check allows one of for rounding.
const grew = a.total - before.total;
check("the duration grew by 120 ms (within a frame of rounding)", Math.abs(grew - 120) <= step, { before: before.total, after: a.total });
const k = await c.call("check", {});
check("check finds no errors", /\b0 errors\b/.test(k.content?.[0]?.text ?? ""), (k.content?.[0]?.text ?? "").split("\n")[0]);
soft("a melee slash effect", /slash|cleave|claw/.test(fxLayer ?? ""), fxLayer);
soft("the hit is recorded with freeze 120", hitsOf(a).some((h) => h.freezeMs === 120), a.hits);
soft("the attack tag still covers the whole animation", a.tags.includes(`attack 1-${a.frames}`), a.tags);
soft("a hit-stop on frame 4 (or where the overlay moved it)", hitsOf(a).some((h) => h.frame >= 4), a.hits);

// The tools themselves (no model): each is one undo step.
await lua(attack);
await c.call("fx_overlay", { id: "sword-slash", tag: "attack", anchor_layer: "Hero", hit_frame: 4, timing: "retime" });
const r = await info();
check("retime inserted frames with the hero's cels linked", r.frames > 6 && r.links === r.frames - 6, r);
check("retime kept the attack's total", r.total === 600, r.total);
check("the attack tag grew over the inserted frames", r.tags.includes(`attack 1-${r.frames}`), r.tags);
await lua(`app.command.Undo() return true`);
const u1 = await info();
check("one undo removes the overlay and its frames", u1.frames === 6 && !u1.layers.some((n) => n.startsWith("AI: fx")) && u1.total === 600, u1);

await c.call("hit_stop", { frame: 4, freeze_ms: 120, shake: { amp: 2, ms: 66 } });
const h = await info();
check("hit_stop grew the total by exactly 120 ms", h.total === 720, h.total);
check("hit_stop added 2 shake frames and grew the tag", h.frames === 8 && h.tags.includes("attack 1-8"), h);
check("the hit is recorded", hitsOf(h).length === 1 && hitsOf(h)[0].frame === 4 && hitsOf(h)[0].freezeMs === 120, h.hits);
const shake = await lua(`local hero = app.sprite.layers[1] local o = {}
  for f = 4, 6 do o[#o + 1] = hero:cel(f).position.x end return o`);
check("shake offsets decay to 0", shake[1] - shake[0] === 2 && shake[2] === shake[0], shake);
await lua(`app.command.Undo() return true`);
const u2 = await info();
check("one undo removes the hit-stop", u2.frames === 6 && u2.total === 600 && hitsOf(u2).length === 0, u2);
done("FX overlay");
