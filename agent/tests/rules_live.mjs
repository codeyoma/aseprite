// Live test of the pixel-art rules (#77): the animate skill reads its timing table
// (read_guide on the animation chapter or one of its rule ids) before it makes a 6-frame walk.
// Run with Aseprite open:  node agent/tests/rules_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

// A 24x32 side-view character standing, with its own palette (never the user's default).
await lua(`local s = Sprite(24, 32, ColorMode.RGB) s.layers[1].name = "Hero"
  local skin, shirt, pants, dark = Color(255, 204, 170), Color(41, 120, 255), Color(60, 60, 90), Color(24, 20, 37)
  local pal = Palette(5) pal:setColor(0, Color(0, 0, 0, 0)) pal:setColor(1, dark) pal:setColor(2, skin) pal:setColor(3, shirt) pal:setColor(4, pants)
  s:setPalette(pal)
  local img = Image(24, 32, ColorMode.RGB)
  for y = 4, 10 do for x = 9, 15 do img:drawPixel(x, y, skin) end end
  img:drawPixel(13, 7, dark)
  for y = 11, 20 do for x = 9, 15 do img:drawPixel(x, y, shirt) end end
  for y = 21, 30 do img:drawPixel(10, y, pants) img:drawPixel(11, y, pants) img:drawPixel(13, y, pants) img:drawPixel(14, y, pants) end
  s.layers[1]:cel(1).image = img return true`);
await chat("/skill:animate make a 6 frame walk cycle");
await ranSkill("animate");

const entries = (await lua("return AsepriteAgent.entries()")) ?? [];
const steps = entries.filter((e) => e.kind === "tool").map((e) => e.text ?? "");
// The step label is "Read guide: <topic>"; the chapter, the index or an animation rule id all count.
const readRules = steps.filter((t) => /^Read guide: (rules\/animation|rules\/anim|rules|(rule:)?anim(\.[\w.-]+)?)$/i.test(t.trim()));
check("the animate skill read its timing table (read_guide on the animation rules)", readRules.length > 0, steps);
const firstEdit = steps.findIndex((t) => /^(Apply timeline|Run Lua|Write \d+ pixel rows|Edit)/i.test(t));
const firstRead = steps.findIndex((t) => readRules.includes(t));
soft("it read the rules before its first edit", firstRead >= 0 && (firstEdit < 0 || firstRead < firstEdit), steps);

const s = await lua(`local s = app.sprite local tag local ms = {}
  for _, t in ipairs(s.tags) do if t.name:lower():match("walk") then tag = t end end
  for _, f in ipairs(s.frames) do ms[#ms + 1] = math.floor(f.duration * 1000 + 0.5) end
  return { frames = #s.frames, tag = tag and (tag.fromFrame.frameNumber .. "-" .. tag.toFrame.frameNumber) or nil, ms = ms }`);
check("new animation frames", s.frames > 1, s);
soft("6 walk frames", s.frames >= 6, s);
// rule:anim.ticks / anim.timing.walk: contacts held longer, so at least two durations, all 70-160 ms.
soft("at least two different durations (rule anim.ticks)", new Set(s.ms).size >= 2, s.ms);
soft("walk durations in the table's range (70-160 ms)", s.ms.every((m) => m >= 70 && m <= 160), s.ms);
done("RULES");
