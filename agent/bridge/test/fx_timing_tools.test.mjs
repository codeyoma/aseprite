// FX on a character's timeline (#70): overlayPlan and hitStopPlan, and fx_overlay / hit_stop on the fake
// document (one put_images request each: one undo step).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFx } from "../dist/fx/library.js";
import { fxCanvas } from "../dist/fx_tools.js";
import { fxImpact, hitStopPlan, layerAnchor, overlayPlan, splitMs } from "../dist/fx_timing_tools.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette", "apply_timeline_text"]);
const writes = (fake) => fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const lit = (im) => {
  const d = im.data ?? im;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
};

/** A 64x64 attack: a Hero rectangle moving right 2 px a frame, an `attack` tag over its 6 frames of 100 ms. */
function attackSprite({ frames = 6, extra = [] } = {}) {
  const durations = Array(frames).fill(100);
  const hero = durations.map((_, i) => rect(64, 64, [20 + 2 * i, 30, 27 + 2 * i, 47], [40, 60, 200]));
  return fakeDocument({
    width: 64, height: 64, durations, layer: "Hero",
    layers: [...extra, { name: "Hero", frames: hero }],
    tags: [{ name: "attack", from: 1, to: frames }],
  });
}
const state = async (fake) => (await fake.request("get_state")).result.activeSprite;
const layerOf = (st, name) => {
  const all = [];
  const walk = (ls) => ls.forEach((l) => { all.push(l); if (l.layers) walk(l.layers); });
  walk(st.layers);
  return all.find((l) => l.name === name);
};

test("splitMs keeps the total; overlayPlan resample adds no frames when the effect fits", () => {
  assert.deepEqual(splitMs(100, 3), [34, 33, 33]);
  assert.equal(sum(splitMs(97, 4)), 97);
  const p = overlayPlan({ durations: [100, 100, 100, 100], from: 1, to: 4, effectMs: 250, loop: false, timing: "resample", stepMs: 33, overflow: "extend" });
  assert.deepEqual(p.inserts, []);
  assert.deepEqual(p.durations, []);
  assert.deepEqual(p.samples, [{ frame: 1, t: 0 }, { frame: 2, t: 100 }, { frame: 3, t: 200 }]);
  assert.equal(p.inserted, 0);
});

test("overlayPlan: hit_frame puts the impact on the hit frame's start; overflow extends or cuts", () => {
  const base = { durations: [100, 100, 100, 100, 100, 100], from: 1, to: 6, effectMs: 750, loop: false, stepMs: 33, hitFrame: 4, impactMs: 60 };
  const cut = overlayPlan({ ...base, timing: "resample", overflow: "cut" });
  assert.equal(cut.samples.find((s) => s.frame === 4).t, 60, "the impact on frame 4");
  assert.deepEqual(cut.samples[0], { frame: 3, t: 0 }, "it starts within frame 3, shown from its first moment");
  assert.equal(cut.inserted, 0);
  assert.equal(cut.cutMs, 750 - 360);
  const ext = overlayPlan({ ...base, timing: "resample", overflow: "extend" });
  assert.equal(ext.extended, Math.ceil(390 / 33));
  assert.deepEqual(ext.inserts, [{ after: 6, durations: Array(ext.extended).fill(33) }]);
  assert.ok(ext.samples.at(-1).t < 750 && ext.samples.at(-1).t + 33 >= 750, "extended to the effect's end");
  // Retimed: frames the effect is on split into ~33 ms parts adding up to 100; the impact stays on the hit frame's start.
  const rt = overlayPlan({ ...base, timing: "retime", overflow: "cut" });
  assert.deepEqual(rt.inserts.map((x) => x.after), [3, 4, 5, 6]);
  assert.equal(rt.durations.length, 4);
  assert.equal(sum(rt.inserts.flatMap((x) => x.durations)) + sum(rt.durations.map((d) => d.ms)), 400, "each split frame keeps its 100 ms");
  assert.equal(rt.hitFrame, 6);
  assert.equal(rt.samples.find((s) => s.frame === rt.hitFrame).t, 60);
  // A loop wraps over the range and never extends.
  const loop = overlayPlan({ durations: [100, 100, 100], from: 1, to: 3, effectMs: 150, loop: true, timing: "resample", stepMs: 33, overflow: "extend" });
  assert.deepEqual(loop.samples.map((s) => s.t), [0, 100, 50]);
  assert.equal(loop.inserted, 0);
});

test("hitStopPlan: the shake comes out of the freeze and decays to 0", () => {
  const p = hitStopPlan(120, { amp: 3, ms: 100 });
  assert.equal(p.contactExtra + sum(p.durations), 120, "the freeze in all");
  assert.equal(p.shakeMs, 100);
  assert.equal(p.durations.length, 3);
  const mags = p.offsets.map((o) => Math.abs(o.x));
  assert.equal(mags[0], 3);
  assert.equal(mags.at(-1), 0, "ends at rest");
  for (let i = 1; i < mags.length; i++) assert.ok(mags[i] <= mags[i - 1], "never grows");
  assert.ok(p.offsets[0].x > 0 && p.offsets[1].x < 0, "alternates");
  const long = hitStopPlan(60, { amp: 2, ms: 200 });
  assert.equal(long.clamped, true);
  assert.equal(long.contactExtra, 0);
  assert.equal(sum(long.durations), 60);
  assert.deepEqual(hitStopPlan(80), { contactExtra: 80, shakeMs: 0, durations: [], offsets: [], clamped: false });
});

test("fxImpact uses a melee effect's act hit; layerAnchor is the bounds centre or bottom centre", () => {
  const slash = findFx("sword-slash");
  const imp = fxImpact(slash, {}, slash.seed, fxCanvas(slash, false, 0));
  assert.equal(imp.from, "act");
  assert.equal(imp.ms, 60);
  assert.deepEqual(imp.act, { freezeMs: 140, shakeMs: 180, amp: 2 });
  const spark = findFx("hit-spark");
  assert.equal(fxImpact(spark, {}, spark.seed, fxCanvas(spark, false, 0)).from, "busiest frame");
  const img = { width: 64, height: 64, data: rect(64, 64, [20, 30, 27, 47], [1, 2, 3]) };
  assert.deepEqual(layerAnchor(img, "center"), { x: 24, y: 39 });
  assert.deepEqual(layerAnchor(img, "ground"), { x: 24, y: 48 });
});

test("fx_overlay resample on a tag: no frames added when it fits, the impact on hit_frame, one write", async () => {
  const fake = attackSprite();
  const r = await runTool(findTool("fx_overlay"), { id: "hit-spark", tag: "attack", x: 40, y: 36, hit_frame: 2 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(writes(fake), ["put_images"], "one write: one undo step");
  const st = await state(fake);
  assert.deepEqual(st.frames.map((f) => f.durationMs), Array(6).fill(100), "no frames added, durations kept");
  assert.match(textOf(r), /lands on frame 2/);
  assert.ok(lit(fake.image("AI: fx hit-spark", 2)) > 0, "the spark is on the hit frame");
  assert.equal(fake.image("AI: fx hit-spark", 1), undefined, "and not before it (its impact comes first)");
  assert.match(textOf(r), /One undo step/);
});

test("fx_overlay retime: frames inserted, the character's cels linked, the tag grows, the timing kept", async () => {
  const fake = attackSprite({ extra: [{ name: "Target", frames: Array(6).fill(rect(64, 64, [50, 30, 55, 47], [200, 60, 40])) }] });
  const before = sum((await state(fake)).frames.map((f) => f.durationMs));
  const r = await runTool(findTool("fx_overlay"), { id: "sword-slash", tag: "attack", anchor_layer: "Hero", hit_frame: 4, timing: "retime" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(writes(fake), ["put_images"]);
  const st = await state(fake);
  const n = st.frames.length;
  assert.ok(n > 6, `${n} frames`);
  assert.equal(sum(st.frames.map((f) => f.durationMs)), before, "retime keeps the total (overflow cut with a tag)");
  assert.deepEqual(st.tags.map((t) => [t.name, t.from, t.to]), [["attack", 1, n]], "the tag grows over the inserted frames");
  // Every Hero cel in an inserted frame is linked to the frame it splits: groups of frames sharing one cel.
  const hero = layerOf(st, "Hero");
  assert.ok(hero.celLinks?.length >= 3, JSON.stringify(hero.celLinks));
  assert.equal(sum(hero.celLinks.map((g) => g.length - 1)), n - 6, "every inserted frame is a link");
  assert.equal(sum(layerOf(st, "Target").celLinks.map((g) => g.length - 1)), n - 6);
  assert.match(textOf(r), /linked/);
  assert.match(textOf(r), /lands on frame (\d+) \(was 4\)/);
  const hit = Number(/lands on frame (\d+)/.exec(textOf(r))[1]);
  assert.ok(lit(fake.image("AI: fx sword-slash", hit)) > 0);
  assert.match(textOf(r), /hit_stop \{ frame: \d+, freeze_ms: 140, shake: \{ amp: 2, ms: 140 \} \}/, "the act's hit-stop is suggested");
  // Then its suggested hit-stop: the character shakes, the effect layer holds (linked), +140 ms in all.
  const h = await runTool(findTool("hit_stop"), { frame: hit, freeze_ms: 140, shake: { amp: 2, ms: 140 } }, fake);
  assert.ok(!h.isError, textOf(h));
  const st2 = await state(fake);
  assert.equal(sum(st2.frames.map((f) => f.durationMs)), before + 140);
  assert.ok(layerOf(st2, "AI: fx sword-slash").celLinks?.some((g) => g[0] === hit), "the effect's cel holds through the shake");
  assert.ok(!layerOf(st2, "Hero").celLinks?.some((g) => g.includes(hit + 1)), "the hero's shake frames are moved copies");
  assert.deepEqual(st2.tags.map((t) => [t.from, t.to]), [[1, st2.frames.length]]);
});

test("fx_overlay with start_frame extends past the end; refuses a bad range", async () => {
  const fake = attackSprite({ frames: 2 });
  const r = await runTool(findTool("fx_overlay"), { id: "hit-spark", start_frame: 1, x: 32, y: 32 }, fake);
  assert.ok(!r.isError, textOf(r));
  const st = await state(fake);
  assert.ok(st.frames.length > 2);
  assert.equal(st.tags[0].to, st.frames.length, "the tag ending on the last frame grows over the linked frames");
  assert.match(textOf(r), /outlasts the range/);
  const bad = await runTool(findTool("fx_overlay"), { id: "hit-spark", tag: "attack", hit_frame: 99 }, attackSprite());
  assert.equal(bad.isError, true);
  const both = await runTool(findTool("fx_overlay"), { id: "hit-spark", tag: "attack", x: 1, y: 1, anchor_layer: "Hero" }, attackSprite());
  assert.equal(both.isError, true);
});

test("hit_stop: the total grows by exactly freeze_ms, shake offsets decay to 0, tags grow, one write, hit recorded", async () => {
  const fake = attackSprite({ extra: [{ name: "Target", frames: Array(6).fill(rect(64, 64, [50, 30, 55, 47], [200, 60, 40])) }] });
  const before = (await state(fake)).frames.map((f) => f.durationMs);
  const r = await runTool(findTool("hit_stop"), { frame: 4, freeze_ms: 120, shake: { amp: 2, ms: 66, layers: ["Hero"] }, flash_layer: "Target" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(writes(fake), ["put_images"], "one write: one undo step");
  const st = await state(fake);
  const after = st.frames.map((f) => f.durationMs);
  assert.equal(sum(after) - sum(before), 120, "exactly freeze_ms");
  assert.equal(after.length, 8, "two shake frames");
  assert.deepEqual(after.slice(3, 6), [154, 33, 33]);
  assert.deepEqual(st.tags.map((t) => [t.from, t.to]), [[1, 8]]);
  assert.deepEqual(st.fxHits, [{ frame: 4, freezeMs: 120, shakeMs: 66, amp: 2 }]);
  // Hero is shaken: its cels in the shake frames are moved copies, decaying to 0; Target is linked to frame 4.
  const hero = fake.active.sprite.layers.find((l) => l.name === "Hero");
  const x4 = hero.cels[3].x;
  assert.deepEqual([hero.cels[4].x - x4, hero.cels[5].x - x4], [2, 0]);
  assert.deepEqual(layerOf(st, "Target").celLinks, [[5, 6]], "linked to the contact cel, which the flash then replaced");
  const target = fake.active.sprite.layers.find((l) => l.name === "Target");
  assert.equal(target.cels[4], target.cels[5], "the shake frames link the target's cel");
  // The flash: Target white in frame 4 only, its alpha kept.
  const white = fake.image("Target", 4), plain = fake.image("Target", 5);
  const i = (35 * 64 + 52) * 4;
  assert.deepEqual([...white.subarray(i, i + 4)], [255, 255, 255, 255]);
  assert.deepEqual([...plain.subarray(i, i + 4)], [200, 60, 40, 255]);
  assert.match(textOf(r), /\+120/);
});

test("hit_stop without shake only lengthens the contact frame; a second hit moves the first", async () => {
  const fake = attackSprite();
  await runTool(findTool("hit_stop"), { frame: 5, freeze_ms: 80 }, fake);
  let st = await state(fake);
  assert.deepEqual(st.frames.map((f) => f.durationMs), [100, 100, 100, 100, 180, 100]);
  await runTool(findTool("hit_stop"), { frame: 2, freeze_ms: 60, shake: { amp: 1, ms: 40 } }, fake);
  st = await state(fake);
  assert.equal(sum(st.frames.map((f) => f.durationMs)), 600 + 80 + 60);
  assert.deepEqual(st.fxHits.map((h) => h.frame), [7, 2], "the first hit moved past the inserted shake frames");
});
