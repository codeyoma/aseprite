// Live test of the fresh-eyes critic and the blind A/B gate (#76).
// Run with Aseprite open:  node agent/tests/critic_live.mjs [claude|codex]
//
// The sprite is a 32x32 character with two deliberate flaws: its feet float
// 3 px above the ground strip, and 1-px noise is scattered around it.
//   1. critique over MCP (no chat): a finding names a flaw.
//   2. ab_compare over MCP: a real fix (frame 1) against a worse "fix" (frame
//      2, still floating and noisier, with holes punched in the body); the
//      worse one must lose. Then the checkpoint path: the worse fix against
//      the original, and a redraw that the 25% guard refuses.
//   3. "/skill:review review this sprite and fix it" through the chat: soft
//      checks that ab_compare ran and that the score went up.
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
// critique and ab_compare called over MCP run outside a chat turn: pick the critic's agent explicitly.
const { c, lua, chat, check, soft, ranSkill, done } = await live({ provider, bridge: { env: { ASEPRITE_AGENT_CRITIC: provider } } });
const textOf = (r) => (r?.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const scoreOf = (t) => Number(/Critique: (\d+(?:\.\d+)?)\/10/.exec(t ?? "")?.[1] ?? NaN);

// Explicit palette: transparent, outline, skin, tunic, legs, grass, dirt.
const PALETTE = `local pal = Palette(7)
  pal:setColor(0, Color(0, 0, 0, 0)) pal:setColor(1, Color(26, 28, 44)) pal:setColor(2, Color(244, 192, 152))
  pal:setColor(3, Color(59, 93, 201)) pal:setColor(4, Color(93, 39, 93)) pal:setColor(5, Color(56, 183, 100))
  pal:setColor(6, Color(37, 113, 121))`;

// Lua that draws the character into image `img`, with `drop` rows between its feet and the ground at y=28.
const CHARACTER = `
  local OUT, SKIN, TUNIC, LEGS = Color(26, 28, 44), Color(244, 192, 152), Color(59, 93, 201), Color(93, 39, 93)
  local function box(img, x0, y0, x1, y1, c) for y = y0, y1 do for x = x0, x1 do img:drawPixel(x, y, c) end end end
  local function figure(img, feet)
    local top = feet - 18
    box(img, 12, top, 19, top + 6, OUT) box(img, 13, top + 1, 18, top + 5, SKIN)        -- head
    img:drawPixel(14, top + 3, OUT) img:drawPixel(17, top + 3, OUT)                       -- eyes
    box(img, 11, top + 7, 20, top + 13, OUT) box(img, 12, top + 8, 19, top + 12, TUNIC)  -- body
    box(img, 12, top + 14, 15, feet, OUT) box(img, 16, top + 14, 19, feet, OUT)           -- legs
    box(img, 13, top + 14, 14, feet - 1, LEGS) box(img, 17, top + 14, 18, feet - 1, LEGS)
  end
  local function noise(img, pts) for _, p in ipairs(pts) do img:drawPixel(p[1], p[2], OUT) end end
  local NOISE = { {3, 5}, {28, 8}, {5, 16}, {26, 20}, {8, 2}, {23, 3}, {2, 24}, {29, 14} }`;

/** A new sprite with Ground and Character layers; frame 1 is the flawed original. */
async function flawedSprite(frames = 1) {
  await lua(`local s = Sprite(32, 32, ColorMode.RGB) ${PALETTE} s:setPalette(pal)
    ${CHARACTER}
    s.layers[1].name = "Ground"
    local ch = s:newLayer() ch.name = "Character"
    for i = 2, ${frames} do s:newEmptyFrame() end
    for f = 1, ${frames} do
      local g = Image(32, 32, ColorMode.RGB)
      for y = 28, 31 do for x = 0, 31 do g:drawPixel(x, y, y == 28 and Color(56, 183, 100) or Color(37, 113, 121)) end end
      s:newCel(s.layers[1], f, g, Point(0, 0))
      local img = Image(32, 32, ColorMode.RGB) figure(img, 24) noise(img, NOISE)
      s:newCel(ch, f, img, Point(0, 0))
    end
    app.activeLayer = ch app.activeFrame = s.frames[1]
    return true`);
}

// ---------------------------------------------------------------------------
// Part 1: critique finds the flaw.
await flawedSprite();
const first = await c.call("critique", { what: "a 32x32 character sprite" });
const firstText = textOf(first);
console.log(firstText);
check("critique answered", !first.isError && /^Critique: \d+(\.\d+)?\/10/.test(firstText), firstText.slice(0, 300));
check("a finding names a flaw (floating feet or 1-px noise)",
  /float|hover|above the ground|gap|not (touch|on|reach)|ground (line|contact)|grounded|stray|noise|orphan|isolated|speck|dirt/i.test(firstText.split("\nCold read:")[1] ?? ""),
  firstText.slice(0, 600));
check("the flawed sprite does not ship", /Not ready/.test(firstText), firstText.split("\n")[0]);
soft("findings cite known rule ids", !/Unknown rule ids/.test(firstText), firstText.match(/Unknown rule ids.*/)?.[0]);
const firstScore = scoreOf(firstText);

// ---------------------------------------------------------------------------
// Part 2: the blind A/B rejects a worse fix.
await flawedSprite(2);
await lua(`local s = app.sprite ${CHARACTER}
  local ch = s.layers[2]
  -- Frame 1, the real fix: feet on the ground, no noise.
  local good = Image(32, 32, ColorMode.RGB) figure(good, 27) ch:cel(1).image = good
  -- Frame 2, the worse "fix": still floating, more noise, holes in the body and head.
  local bad = Image(32, 32, ColorMode.RGB) figure(bad, 24) noise(bad, NOISE)
  noise(bad, { {1, 1}, {30, 2}, {4, 10}, {27, 26}, {10, 26}, {21, 25}, {6, 20}, {24, 12} })
  for _, p in ipairs({ {14, 14}, {17, 15}, {15, 9}, {13, 16}, {18, 13} }) do bad:drawPixel(p[1], p[2], Color(0, 0, 0, 0)) end
  ch:cel(2).image = bad
  return true`);
const ab = await c.call("ab_compare", { a: { frame: 1 }, b: { frame: 2 }, what: "a 32x32 character sprite" });
const abText = textOf(ab);
console.log(abText);
check("ab_compare answered with a blind order", !ab.isError && /Blind order \(comparison #\d+\): A was/.test(abText), abText.slice(0, 300));
check("the worse fix is rejected (frame 1, the real fix, wins)", /Verdict: a \(the sprite, frame 1\) is better/.test(abText), abText.split("\n")[0]);

// The checkpoint path: the worse fix against the original (soft: either can look worse), and a redraw refused.
await flawedSprite();
await c.call("diff_visual", { save: "live-review" });
await lua(`local s = app.sprite ${CHARACTER}
  local ch = s.layers[2] local img = ch:cel(1).image:clone()
  noise(img, { {1, 1}, {30, 2}, {4, 10}, {27, 26}, {10, 26}, {21, 25} })
  for _, p in ipairs({ {14, 14}, {17, 15}, {15, 9} }) do img:drawPixel(p[1], p[2], Color(0, 0, 0, 0)) end
  ch:cel(1).image = img return true`);
const worse = await c.call("ab_compare", { checkpoint: "live-review", what: "a 32x32 character sprite" });
console.log(textOf(worse));
check("the checkpoint comparison passes the guard and gives a verdict", /Fix guard passed/.test(textOf(worse)) && /Verdict:/.test(textOf(worse)), textOf(worse).slice(0, 300));
soft("the worse change loses to the checkpoint", /Verdict: checkpoint "live-review" \(before the fix\) is better|Verdict: tie/.test(textOf(worse)), textOf(worse).split("\n")[0]);
await lua(`local s = app.sprite ${CHARACTER}
  local img = Image(32, 32, ColorMode.RGB) figure(img, 27)
  local moved = Image(32, 32, ColorMode.RGB) moved:drawImage(img, Point(-8, 0))
  s.layers[2]:cel(1).image = moved return true`);
const redraw = await c.call("ab_compare", { checkpoint: "live-review" });
check("a redraw is refused by the 25% guard", /Fix round refused/.test(textOf(redraw)) && !/Verdict:/.test(textOf(redraw)), textOf(redraw).slice(0, 300));

// ---------------------------------------------------------------------------
// Part 3: the review skill through the chat.
await flawedSprite();
await chat("/skill:review review this sprite and fix it", { timeout: 1_500_000 });
await ranSkill("review");
const entries = (await lua("return AsepriteAgent.entries()")) ?? [];
const tools = entries.filter((e) => e.kind === "tool");
const critiques = tools.filter((e) => e.text === "Ask a fresh critic");
const compares = tools.filter((e) => e.text === "Blind A/B comparison");
check("the skill ran critique", critiques.length >= 1, tools.map((e) => e.text));
soft("the skill ran ab_compare", compares.length >= 1, tools.map((e) => e.text));
const after = await c.call("critique", { what: "a 32x32 character sprite" });
const afterScore = scoreOf(textOf(after));
console.log(`score before ${firstScore}, after the review ${afterScore}`);
soft("the score went up after the review", afterScore > firstScore, { firstScore, afterScore });
const state = await lua(`local s = app.sprite local ch = s.layers[2] local img = ch:cel(1).image local pos = ch:cel(1).position
  local low = -1 for y = 0, img.height - 1 do for x = 0, img.width - 1 do if app.pixelColor.rgbaA(img:getPixel(x, y)) > 0 then low = math.max(low, y + pos.y) end end end
  return { lowest = low }`);
soft("the feet reach the ground (lowest character row 27)", state?.lowest === 27, state);
done("Critic");
