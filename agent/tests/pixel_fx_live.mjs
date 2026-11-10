// Live test of the Pixel FX skill (#73): "add a frost nova to my mage's attack". The library has no ice
// effects, so the agent should write a recipe (or recolor one) and time it to the attack.
// Run with Aseprite open:  node agent/tests/pixel_fx_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, ranSkill, done } = await live({ provider });

// A 160x112 mage (robe, hood, staff) that raises the staff and thrusts it forward over a 6-frame `attack` tag of
// 100 ms frames. The palette is set so `check` does not depend on the user's default palette.
await lua(`local s = Sprite(160, 112, ColorMode.RGB) s.layers[1].name = "Mage"
  local robe, hood, staff, skin = Color(80, 40, 160), Color(50, 25, 110), Color(120, 80, 40), Color(240, 200, 160)
  local pal = Palette(5) pal:setColor(0, Color(0, 0, 0, 0)) pal:setColor(1, robe) pal:setColor(2, hood) pal:setColor(3, staff) pal:setColor(4, skin) s:setPalette(pal)
  for _ = 2, 6 do s:newEmptyFrame() end
  local lean = { 0, -1, -2, 2, 3, 1 }
  local tip = { -6, -10, -12, 4, 6, 0 }
  for f = 1, 6 do
    s.frames[f].duration = 0.1
    local img = Image(160, 112, ColorMode.RGB)
    local x0 = 72 + lean[f]
    for y = 74, 99 do for x = x0 - math.floor((y - 74) / 5), x0 + 9 + math.floor((y - 74) / 5) do img:drawPixel(x, y, robe) end end
    for y = 62, 73 do for x = x0 + 1, x0 + 8 do img:drawPixel(x, y, hood) end end
    for y = 66, 70 do for x = x0 + 3, x0 + 6 do img:drawPixel(x, y, skin) end end
    local sx = x0 + 14 + math.max(tip[f], 0)
    for y = 60 + math.min(tip[f], 0), 96 do img:drawPixel(sx, y, staff) end
    s:newCel(s.layers[1], f, img, Point(0, 0))
  end
  local t = s:newTag(1, 6) t.name = "attack"
  app.frame = s.frames[1] return true`);

const info = () => lua(`local s = app.sprite local o = { frames = #s.frames, layers = {}, tag = nil, hits = {}, fx = {}, rgb = { 0, 0, 0, 0 } }
  for _, t in ipairs(s.tags) do if t.name == "attack" then o.tag = { from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber } end end
  for _, h in ipairs(s.properties("aseprite-agent")["fx.hits"] or {}) do o.hits[#o.hits + 1] = { frame = h.frame, freezeMs = h.freezeMs } end
  local function walk(list) for _, l in ipairs(list) do
    if l.isGroup then walk(l.layers) else
      o.layers[#o.layers + 1] = l.name
      if l.name:match("^AI: fx") and not l.name:match(" glow$") then
        for f = 1, #s.frames do local cel = l:cel(f)
          if cel and not cel.image:isEmpty() then
            o.fx[#o.fx + 1] = f
            for it in cel.image:pixels() do local v = it()
              local a = app.pixelColor.rgbaA(v)
              if a >= 128 then o.rgb[1] = o.rgb[1] + app.pixelColor.rgbaR(v) o.rgb[2] = o.rgb[2] + app.pixelColor.rgbaG(v)
                o.rgb[3] = o.rgb[3] + app.pixelColor.rgbaB(v) o.rgb[4] = o.rgb[4] + 1 end
            end
          end
        end
      end
    end
  end end
  walk(s.layers)
  return o`);
// An empty Lua table may come back as {}.
const list = (x) => (Array.isArray(x) ? x : []);
/** Hue in degrees of an average color. */
function hue([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return undefined;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

await chat("/skill:pixel-fx add a frost nova to my mage's attack");
await ranSkill("pixel-fx");
const a = await info();
const fxLayers = list(a.layers).filter((n) => /^AI: fx /.test(n));
check("an AI: fx layer exists", fxLayers.length > 0, a.layers);
const fxFrames = list(a.fx);
check("the effect is drawn on some frames", fxFrames.length > 0, a);
check("the effect is on frames within or after the attack tag", !!a.tag && fxFrames.length > 0 && fxFrames.every((f) => f >= a.tag.from), { tag: a.tag, frames: fxFrames });
const k = await c.call("check", {});
const kt = k.content?.[0]?.text ?? "";
check("check finds no errors", /\b0 errors\b/.test(kt), kt.split("\n")[0]);

const entries = (await lua("return AsepriteAgent.entries()")) ?? [];
const tools = list(entries).filter((e) => e.kind === "tool").map((e) => `${e.text ?? ""} ${e.detail ?? ""}`).join(" | ");
soft("timed to the attack (fx_overlay or hit_frame)", /on the animation|fx_overlay|hit_frame/i.test(tools), tools.slice(0, 400));
soft("a hit recorded (hit_stop)", list(a.hits).length > 0, a.hits);
soft("the effect starts inside the attack", !!a.tag && fxFrames.some((f) => f <= a.tag.to), { tag: a.tag, frames: fxFrames });
const n = a.rgb?.[3] ?? 0;
const avg = n ? [a.rgb[0] / n, a.rgb[1] / n, a.rgb[2] / n] : [0, 0, 0];
const h = hue(avg);
soft("icy colors (average hue blue-ish, 170-250)", h !== undefined && h >= 170 && h <= 250, { avg: avg.map(Math.round), hue: h && Math.round(h) });
const fk = await c.call("check_fx", {});
soft("check_fx finds no errors", /\b0 errors\b/.test(fk.content?.[0]?.text ?? ""), (fk.content?.[0]?.text ?? "").split("\n")[0]);
done("Pixel FX");
