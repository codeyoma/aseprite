// FX recipes and the FX check (#72): the recipe schema, compiled recipes (determinism, loops, one-shots),
// fx_from_recipe on the fake document, and check_fx on library effects and purpose-built bad cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFx } from "../dist/fx/index.js";
import { compileRecipe, parseRecipe, recipeEntry } from "../dist/fx/recipe.js";
import { checkFxLayer } from "../dist/fx_recipe_tools.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const lit = (im) => {
  const d = im.data ?? im;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
};
const same = (a, b) => Buffer.compare(Buffer.from(a.data ?? a), Buffer.from(b.data ?? b)) === 0;
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette"]);

/** A one-shot: a flash, a spark burst with a ring and a light, all gone by 0.6 s. */
const BURST = {
  name: "blue-burst", size: [96, 96], origin: [48, 48], duration: 0.6, seed: 3,
  palette: ["#10162e", "#2a4a8c", "#4f8fe0", "#9fd4ff", "#ffffff"],
  phases: [
    { name: "flash", start: 0, end: 0.1, shapes: [{ type: "disc", radius: [6, 2], color: -1 }, { type: "glow", radius: 20, alpha: [0.8, 0] }] },
    { name: "burst", start: 0, end: 0.4, emitters: [{ kind: "spark", count: 16, speed: [80, 160], life: [0.2, 0.35] }],
      rings: [{ radius: [3, 22], width: [3, 1], color: "cool" }], lights: [{ radius: 24, strength: 0.6, life: 0.25 }] },
  ],
};
/** A loop: embers and flames rising all the time, particles living past the 1 s seam. */
const EMBERS = {
  name: "embers", size: [48, 64], origin: [24, 56], duration: 1, loop: true, anchor: "ground",
  palette: ["#2a0a05", "#8a2a10", "#f2761d", "#ffd06b", "#ffffff"],
  phases: [{ name: "linger", start: 0, end: 1,
    emitters: [
      { kind: "ember", count: 12, speed: [10, 30], life: [0.8, 1.6], over: 1, radius: 6 },
      { kind: "fire", count: 20, speed: [5, 15], life: [0.3, 0.6], over: 1, size: [1.5, 2.5] },
    ],
    shapes: [{ type: "glow", radius: 14, alpha: 0.4 }] }],
};

const problems = (bad) => {
  try { parseRecipe(bad); } catch (e) { return e.message; }
  assert.fail("the recipe should have been rejected");
};

test("the schema rejects bad recipes and says where and why", () => {
  const m = problems({ name: "Bad Name", size: [300, 10], origin: [1, 1], duration: 9, palette: ["#fff"],
    phases: [{ name: "boom", start: 0, end: 1, emitters: [{ kind: "laser", count: 999, speed: 1, life: 1 }] }] });
  assert.match(m, /^The recipe has problems:/);
  assert.match(m, /- name: name is 1-40 lowercase letters/);
  assert.match(m, /- size\.0: size must be at most 256/);
  assert.match(m, /- duration: duration must be at most 6/);
  assert.match(m, /- palette: palette needs at least 4 colors/);
  assert.match(m, /- phases\.0\.name: phase name must be one of charge, flash, burst, linger, decay/);
  assert.match(m, /- phases\.0\.emitters\.0\.kind: kind must be one of spark, mote/);
  assert.match(m, /- phases\.0\.emitters\.0\.count: count must be at most 400/);
  // Cross-field rules, once the fields themselves are fine.
  const p = (phases, extra = {}) => problems({ ...BURST, ...extra, phases });
  assert.match(p([{ name: "burst", start: 0.3, end: 0.2, lights: [{ radius: 4 }] }]), /phases\.0\.end: end must be after start/);
  assert.match(p([{ name: "burst", start: 0, end: 0.9, lights: [{ radius: 4 }] }]), /phases\.0\.end: end 0\.9 is past the duration \(0\.6 s\)/);
  assert.match(p([{ name: "burst", start: 0, end: 0.2 }]), /phases\.0: a phase needs something to draw/);
  assert.match(p(BURST.phases, { origin: [100, 3] }), /origin: origin must be inside size \(96x96\)/);
  assert.match(p([{ name: "burst", start: 0, end: 0.2, emitters: [1, 2, 3, 4].map(() => ({ kind: "spark", count: 400, speed: 1, life: 0.1 })) }]), /1600 particles in all; at most 1200/);
  assert.match(p([{ name: "burst", start: 0, end: 0.2, lights: [{ radius: 4, colour: 2 }] }]), /phases\.0\.lights\.0: Unrecognized key: "colour"/);
  assert.match(p([{ name: "burst", start: 0, end: 0.2, rings: [{ radius: 4, color: "red" }] }]), /phases\.0\.rings\.0\.color/);
  assert.match(problems("{ not json"), /not valid JSON/);
  // Good recipes parse, from an object or JSON text.
  assert.equal(parseRecipe(JSON.stringify(BURST)).name, "blue-burst");
  assert.equal(parseRecipe(EMBERS).loop, true);
});

test("a compiled recipe is an effect module: the same recipe and seed give identical frames", () => {
  const mod = compileRecipe(parseRecipe(BURST));
  assert.deepEqual(mod.meta.size, [96, 96]);
  assert.equal(mod.meta.duration, 0.6);
  const a = renderFx(mod, {}, { fps: 30, seed: 3 });
  const b = renderFx(compileRecipe(parseRecipe(BURST)), {}, { fps: 30, seed: 3 });
  assert.equal(a.frames.length, 19);
  assert.ok(a.frames.every((f, i) => same(f, b.frames[i]) && same(a.glow[i], b.glow[i])), "identical frames and light");
  assert.ok(lit(a.frames[0]) > 0 && lit(a.glow[0]) > 0, "it draws and lights");
  const c = renderFx(mod, {}, { fps: 30, seed: 4 });
  assert.ok(a.frames.some((f, i) => !same(f, c.frames[i])), "another seed gives other sparks");
  // A palette ramp recolors it (the core resamples it to the recipe's length).
  const red = renderFx(mod, { palette: ["#200000", "#ff0000"] }, { fps: 30, seed: 3 });
  assert.ok(!same(red.frames[0], a.frames[0]));
});

test("a one-shot recipe ends empty", () => {
  const r = renderFx(compileRecipe(parseRecipe(BURST)), {}, { fps: 30, seed: 3 });
  assert.equal(lit(r.frames.at(-1)), 0, "nothing at t = duration");
  assert.equal(lit(r.glow.at(-1)), 0, "no light either");
});

test("a looping recipe wraps: t and t + duration are the same frame, particles cross the seam", () => {
  const mod = compileRecipe(parseRecipe(EMBERS));
  const r = renderFx(mod, {}, { times: [0, 0.25, 0.5, 1, 1.25, 2.5, 3], seed: 1 });
  assert.ok(same(r.frames[0], r.frames[3]) && same(r.frames[0], r.frames[6]), "0, 1 s and 3 s");
  assert.ok(same(r.frames[1], r.frames[4]), "0.25 s and 1.25 s");
  assert.ok(same(r.frames[2], r.frames[5]), "0.5 s and 2.5 s");
  assert.ok(same(r.glow[0], r.glow[3]));
  assert.ok(lit(r.frames[0]) > 0, "particles from the cycle before are still there at 0");
  assert.ok(!same(r.frames[0], r.frames[1]), "it moves");
  // At its own fps, the frame after the last is the first.
  const f = renderFx(mod, {}, { fps: 30, seed: 1, frames: 31 });
  assert.ok(same(f.frames[30], f.frames[0]));
});

test("recipeEntry: id 'recipe:<name>', the recipe's size, origin, anchor and timing", () => {
  const e = recipeEntry(parseRecipe(EMBERS));
  assert.equal(e.id, "recipe:embers");
  assert.equal(e.loop, true);
  assert.equal(e.durationMs, 1000);
  assert.deepEqual(e.origin, { x: 24, y: 56 });
  assert.equal(e.anchor, "ground");
  assert.equal(recipeEntry(parseRecipe(BURST)).anchor, "center");
});

const sprite = (w = 128, h = 128, durations = [100]) => fakeDocument({
  width: w, height: h, durations, layers: [{ name: "Hero", frames: durations.map(() => rect(w, h, [w / 2 - 4, h / 2 - 8, w / 2 + 3, h / 2 + 7], [40, 60, 200])) }], layer: "Hero",
});
const layerOf = async (fake, name) => {
  const all = [];
  const walk = (ls) => ls.forEach((l) => { all.push(l); if (l.layers) walk(l.layers); });
  walk((await fake.request("get_state")).result.activeSprite.layers);
  return all.find((l) => l.name === name);
};

test("fx_from_recipe: preview writes nothing, layer is add_fx in one request with the recipe recorded, sprite is new_fx_sprite", async () => {
  const fake = sprite();
  const tool = findTool("fx_from_recipe");
  const pv = await runTool(tool, { recipe: BURST }, fake);
  assert.ok(!pv.isError, textOf(pv));
  assert.equal(pv.content[0].type, "image");
  assert.match(textOf(pv), /recipe:blue-burst.*A one-shot: its last frame is empty/s);
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);

  const add = await runTool(tool, { recipe: BURST, apply: "layer", x: 64, y: 64 }, fake);
  assert.ok(!add.isError, textOf(add));
  assert.match(textOf(add), /Added blue-burst \(recipe:blue-burst\) with its visual centre at 64,64.*One undo step/);
  assert.deepEqual(fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method), ["put_images"]);
  const fx = (await layerOf(fake, "AI: fx recipe:blue-burst")).fx;
  assert.equal(fx.id, "recipe:blue-burst");
  assert.deepEqual(JSON.parse(fx.recipe), parseRecipe(BURST), "the recipe is stored with the effect");
  assert.ok(fx.recipe.length < 2000, `${fx.recipe.length} characters`);
  assert.equal((await layerOf(fake, "AI: fx recipe:blue-burst glow")).blendMode, "addition");

  const bad = await runTool(tool, { recipe: { ...BURST, duration: 60 }, apply: "layer" }, fake);
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /duration: duration must be at most 6/);

  const made = await runTool(tool, { recipe: EMBERS, apply: "sprite" }, fake);
  assert.ok(!made.isError, textOf(made));
  assert.match(textOf(made), /30 frames of 48x64 at 30 fps.*tag embers, a seamless loop/);
  const st = (await fake.request("get_state")).result.activeSprite;
  assert.equal(st.layers[0].fx.id, "recipe:embers");
  assert.equal(JSON.parse(st.layers[0].fx.recipe).name, "embers");
});

test("check_fx passes on library effects added with add_fx and on a recipe added in the middle", async () => {
  const fake = sprite(256, 256);
  for (const [id, x, y] of [["hit-spark", 70, 60], ["sword-slash", 180, 70], ["rune-circle", 70, 220], ["ball-lightning", 186, 220]]) {
    const r = await runTool(findTool("add_fx"), { id, x, y, start_frame: 1 }, fake);
    assert.ok(!r.isError, textOf(r));
  }
  await runTool(findTool("fx_from_recipe"), { recipe: BURST, apply: "layer", x: 128, y: 128, start_frame: 1 }, fake);
  const r = await runTool(findTool("check_fx"), {}, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /^FX check: 0 errors, 0 warnings \(5 layers: .*\)\. No problems found\.$/);
  assert.match(textOf(r), /AI: fx hit-spark \(hit-spark, one-shot\)/);
  assert.match(textOf(r), /AI: fx rune-circle \(rune-circle, loop\)/);
  assert.match(textOf(r), /AI: fx recipe:blue-burst \(recipe:blue-burst, one-shot\)/);
  // Soft effects (smoke, fire) blend many colors: the colors rule says so, with its limit.
  const smoke = sprite(256, 256);
  await runTool(findTool("add_fx"), { id: "torch", x: 128, y: 200, start_frame: 1 }, smoke);
  assert.match(textOf(await runTool(findTool("check_fx"), {}, smoke)), /0 errors, 1 warnings.*\n- warning colors .*colors on the layer \(more than 24\)/);
});

test("check_fx finds spills: off the sprite (re-rendered at the record's origin, with coordinates) and past the effect's canvas", async () => {
  const fake = sprite(64, 64);
  await runTool(findTool("fx_from_recipe"), { recipe: BURST, apply: "layer", x: 4, y: 32 }, fake);
  const r = await runTool(findTool("check_fx"), { layer: "AI: fx recipe:blue-burst" }, fake);
  const t = textOf(r);
  assert.match(t, /error spill \[L\d+ AI: fx recipe:blue-burst\]: up to \d+ px of the effect fall outside the 64x64 sprite .* at \(-\d+,\d+\)/);
  // A canvas too small for its sparks: drawn past it, so add_fx cut them.
  const tight = { ...BURST, name: "tight", size: [16, 16], origin: [8, 8] };
  const fake2 = sprite(128, 128);
  await runTool(findTool("fx_from_recipe"), { recipe: tight, apply: "layer", x: 64, y: 64 }, fake2);
  const t2 = textOf(await runTool(findTool("check_fx"), {}, fake2));
  assert.match(t2, /0 errors, 1 warnings/);
  assert.match(t2, /warning spill .*past the effect's own 16x16 canvas.*\n  fix: grow the recipe's size/);
});

test("check_fx finds a one-shot that does not end empty, a loop seam and too many colors", async () => {
  // Sparks that live past the duration.
  const late = { ...BURST, name: "late", phases: [{ name: "linger", start: 0, end: 0.3, emitters: [{ kind: "star", count: 6, speed: [5, 10], life: 2, size: 2 }] }] };
  const fake = sprite();
  await runTool(findTool("fx_from_recipe"), { recipe: late, apply: "layer", x: 64, y: 64 }, fake);
  assert.match(textOf(await runTool(findTool("check_fx"), {}, fake)), /warning one-shot-end .*px still drawn at t = duration \(600 ms\): the one-shot pops off.* at \(\d+,\d+\)/);

  // A loop on frames whose durations don't make a whole loop: the last frame jumps back to the first.
  const loop = sprite(96, 96, Array(10).fill(100));
  await runTool(findTool("fx_from_recipe"), { recipe: { ...EMBERS, phases: [EMBERS.phases[0], { name: "burst", start: 0, end: 0.7, shapes: [{ type: "disc", y: -24, radius: [4, 16], alpha: 1, ease: "linear" }] }] }, apply: "layer", x: 48, y: 80, start_frame: 1 }, loop);
  // 10 frames at 100 ms show one 1 s loop; drop to 7 frames by checking only those images.
  const st = (await loop.request("get_state")).result.activeSprite;
  const l = st.layers.find((x) => x.name.startsWith("AI: fx recipe:embers") && !x.name.endsWith("glow"));
  const info = { id: l.id, name: l.name, visible: true, group: false, path: [], fx: l.fx };
  const imgs = loop.images(l.name).map((d) => d && { width: 96, height: 96, data: d });
  assert.equal(imgs.length, 10);
  assert.deepEqual(checkFxLayer(info, imgs, { width: 96, height: 96 }).filter((f) => f.rule === "loop-seam"), [], "a whole loop has no seam");
  const seam = checkFxLayer(info, imgs.slice(0, 7), { width: 96, height: 96 }).find((f) => f.rule === "loop-seam");
  assert.ok(seam, "7 of 10 frames: the growing disc jumps from 0.6 s back to 0");
  assert.match(seam.message, /the loop jumps: \d+ px change from frame 7 back to frame 1 \(a normal step changes \d+\)/);
  assert.ok(seam.pixels.length > 0);

  // Colors: a tight limit.
  const colors = textOf(await runTool(findTool("check_fx"), { max_colors: 3 }, loop));
  assert.match(colors, /warning colors .*: \d+ colors on the layer \(more than 3\)/);
});

test("check_fx without a record to render: pixels on the sprite's edge, a one-shot cut by the sprite's end", () => {
  const w = 16, h = 16;
  const at = (x, y) => ({ width: w, height: h, data: rect(w, h, [x, y, x, y], [255, 200, 0]) });
  const layer = { id: "L9", name: "AI: fx mine", visible: true, group: false, path: [] };
  const edge = checkFxLayer(layer, [at(5, 5), at(0, 7)], { width: w, height: h });
  assert.deepEqual(edge.map((f) => [f.rule, f.frame, f.pixels]), [["spill", 2, [[0, 7]]]]);
  const cut = checkFxLayer({ ...layer, fx: { id: "gone", x: 8, y: 8, fps: 30, loop: false, windupMs: 0 } }, [at(5, 5), at(6, 6)], { width: w, height: h });
  assert.deepEqual(cut.map((f) => [f.rule, f.frame]), [["one-shot-end", 2]]);
});
