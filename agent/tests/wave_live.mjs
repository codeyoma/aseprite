// Live test of the animation-first tool set (#113): a plain "make him wave" (no /skill) reaches the animation
// tools without a find_tools round trip; with part layers the agent plans a clip and fills the in-betweens.
// Run with Aseprite open:  node agent/tests/wave_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, soft, done } = await live({ provider });

// A 32x32 side-view kid on part layers: torso (with head and legs) and a near arm hanging from the shoulder.
await lua(`local s = Sprite(32, 32, ColorMode.RGB)
  s.layers[1].name = "torso"
  local arm = s:newLayer() arm.name = "near arm"
  local body, a = Image(32, 32, ColorMode.RGB), Image(32, 32, ColorMode.RGB)
  local skin, shirt, pants, dark = Color(255, 204, 170), Color(41, 120, 255), Color(60, 60, 90), Color(24, 20, 37)
  for y = 4, 11 do for x = 12, 18 do body:drawPixel(x, y, skin) end end
  body:drawPixel(17, 7, dark)
  for y = 12, 21 do for x = 12, 18 do body:drawPixel(x, y, shirt) end end
  for y = 22, 30 do body:drawPixel(13, y, pants) body:drawPixel(14, y, pants) body:drawPixel(16, y, pants) body:drawPixel(17, y, pants) end
  for y = 13, 20 do a:drawPixel(19, y, shirt) a:drawPixel(20, y, shirt) end
  a:drawPixel(19, 21, skin) a:drawPixel(20, 21, skin)
  s.layers[1]:cel(1).image = body
  s:newCel(arm, 1, a, Point(0, 0))
  palette = Palette(5) palette:setColor(0, Color(0, 0, 0, 0)) palette:setColor(1, skin) palette:setColor(2, shirt) palette:setColor(3, pants) palette:setColor(4, dark)
  s:setPalette(palette) return true`);
await chat("Make him wave his hand: a short looping wave, about 6 frames, tagged wave.");
const steps = ((await lua("return AsepriteAgent.entries()")) ?? []).filter((e) => e.kind === "tool").map((e) => (e.text ?? "").slice(0, 120));
const s = await lua(`local s = app.sprite local tag
  for _, t in ipairs(s.tags) do if t.name:lower():match("wave") then tag = t end end
  local motion = s.properties("aseprite-agent")["motion"]
  return { frames = #s.frames, tag = tag and (tag.fromFrame.frameNumber .. "-" .. tag.toFrame.frameNumber) or nil, motion = motion }`);
check("a wave tag with frames", s.frames >= 3 && !!s.tag, s);
check("no find_tools round trip before the animation tools", !steps.some((t) => /find tools|find_tools|Search tools/i.test(t)), steps);
soft("the clip was planned (motion_clip)", typeof s.motion === "string" && s.motion.includes('"wave"'), { motion: s.motion?.slice(0, 200), steps });
soft("in-betweens came from inbetween", steps.some((t) => /In-betweens/i.test(t)), steps);
done("WAVE");
