// Live test of Animate (#42): a 6-frame walk cycle for a simple character.
// Run with Aseprite open:  node agent/tests/animate_live.mjs [claude|codex]
import { live } from "./live.mjs";
import { textOf } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, done } = await live({ provider });

// A 24x32 side-view character: head, torso and two legs standing.
await lua(`local s = Sprite(24, 32, ColorMode.RGB) s.layers[1].name = "Hero"
  local img = Image(24, 32, ColorMode.RGB)
  local skin, shirt, pants, dark = Color(255, 204, 170), Color(41, 120, 255), Color(60, 60, 90), Color(24, 20, 37)
  for y = 4, 10 do for x = 9, 15 do img:drawPixel(x, y, skin) end end
  img:drawPixel(13, 7, dark)
  for y = 11, 20 do for x = 9, 15 do img:drawPixel(x, y, shirt) end end
  for y = 21, 30 do img:drawPixel(10, y, pants) img:drawPixel(11, y, pants) img:drawPixel(13, y, pants) img:drawPixel(14, y, pants) end
  s.layers[1]:cel(1).image = img return true`);
await chat("/skill:animate Make a 6-frame walk cycle for this character, tagged walk. Keep it simple.");
const s = await lua(`local s = app.sprite local tag
  for _, t in ipairs(s.tags) do if t.name:lower():match("walk") then tag = t end end
  local distinct, imgs = 0, {}
  for f = 1, #s.frames do local i = Image(s.width, s.height, ColorMode.RGB) i:drawSprite(s, f) imgs[f] = i end
  for f = 2, #s.frames do if not imgs[f]:isEqual(imgs[f - 1]) then distinct = distinct + 1 end end
  return { frames = #s.frames, tag = tag and (tag.fromFrame.frameNumber .. "-" .. tag.toFrame.frameNumber) or nil, changes = distinct }`);
check("6 walk frames in a walk tag", s.frames >= 6 && s.tag && s.tag.startsWith("1-") && +s.tag.split("-")[1] >= 6, s);
check("every frame differs from the one before", s.changes >= 5, s);
const r = await c.call("check", { rules: ["duplicate-frame", "ground-jitter"] });
check("check: no repeated frames or jittering feet", /Check: 0 errors, 0 warnings/.test(textOf(r)), textOf(r).slice(0, 400));
done("ANIMATE");
