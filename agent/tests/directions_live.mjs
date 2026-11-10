// Live test of Make 4 or 8 directions (#43): from S and E views to all 8.
// Run with Aseprite open:  node agent/tests/directions_live.mjs [claude|codex]
import { tagDirection } from "../bridge/dist/directions.js";
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

// Frame 1: facing south (front, two eyes). Frame 2: facing east (side, one eye on the right, nose).
await lua(`local s = Sprite(16, 24, ColorMode.RGB) s:newFrame() s.layers[1].name = "Hero"
  local skin, shirt, dark = Color(255, 204, 170), Color(41, 120, 255), Color(24, 20, 37)
  local function base() local i = Image(16, 24, ColorMode.RGB)
    for y = 2, 9 do for x = 4, 11 do i:drawPixel(x, y, skin) end end
    for y = 10, 19 do for x = 4, 11 do i:drawPixel(x, y, shirt) end end
    for y = 20, 23 do i:drawPixel(5, y, dark) i:drawPixel(6, y, dark) i:drawPixel(9, y, dark) i:drawPixel(10, y, dark) end
    return i end
  local front = base() front:drawPixel(6, 5, dark) front:drawPixel(9, 5, dark)
  local side = base() side:drawPixel(10, 5, dark) side:drawPixel(12, 6, skin)
  s.layers[1]:cel(1).image = front s.layers[1]:cel(2).image = side
  local a = s:newTag(1, 1) a.name = "S" local b = s:newTag(2, 2) b.name = "E" return true`);
await chat("/skill:make-directions Make all 8 directions of this character (one frame each). S and E exist.");
await ranSkill("make-directions");
const tags = await lua(`local s = app.sprite local o = {}
  for _, t in ipairs(s.tags) do
    local f = t.fromFrame.frameNumber local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, f)
    o[#o + 1] = { name = t.name, from = f, empty = img:isEmpty() }
  end return o`);
const dirs = new Set(tags.map((t) => tagDirection(t.name)).filter(Boolean));
check("new direction tags", tags.length > 2, tags.map((t) => t.name));
soft("all 8 directions have a tag", ["S", "SW", "W", "NW", "N", "NE", "E", "SE"].every((d) => dirs.has(d)), tags.map((t) => t.name));
check("every direction has a drawing", tags.every((t) => !t.empty), tags);
const w = await lua(`local s = app.sprite local e, wt
  for _, t in ipairs(s.tags) do local n = t.name:upper() if n:match("%f[%a]E%f[%A]") or n == "E" then e = t end if n:match("%f[%a]W%f[%A]") or n == "W" then wt = t end end
  if not e or not wt then return false end
  local a = Image(s.width, s.height, ColorMode.RGB) a:drawSprite(s, e.fromFrame.frameNumber) a:flip(FlipType.HORIZONTAL)
  local b = Image(s.width, s.height, ColorMode.RGB) b:drawSprite(s, wt.fromFrame.frameNumber)
  return a:isEqual(b)`);
soft("W is the mirror of E", w === true, w);
done("DIRECTIONS");
