// The FX domain module (#97): layer naming, the FX record (build, wire, parse; older records), placement shared by
// context preview and placement, check_fx on the placed cels (an irregularly timed overlay), re-rendering fluid and
// pipeline records, fx_pipeline re-apply replacing its layer, and the curated frost nova through the whole workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentOf, parseState } from "../dist/document.js";
import { FROST_NOVA } from "../dist/fx/examples.js";
import { renderFx } from "../dist/fx/index.js";
import { parseRecipe, recipeEntry } from "../dist/fx/recipe.js";
import {
  aiLayer, buildRecord, freeLayerName, glowBase, isFxGlowName, isFxLayerName, parseRecord, recordKind, recordWire,
} from "../dist/fx/record.js";
import { rerender } from "../dist/fx/render_record.js";
import { fxExport } from "../dist/export_tools.js";
import { originalFrame } from "../dist/fx_timing_tools.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette"]);
const writes = (fake) => fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method);
const state = async (fake) => (await fake.request("get_state")).result.activeSprite;
const layerOf = (st, name) => st.layers.find((l) => l.name === name);
const opaque = (im) => {
  if (!im) return 0;
  const d = im.data ?? im;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++;
  return n;
};
const run = (name, input, fake) => runTool(findTool(name), input, fake);

test("layer naming: 'AI: fx <id>', its glow, and a free name for a second effect", () => {
  assert.equal(aiLayer("fx hit-spark"), "AI: fx hit-spark");
  assert.equal(glowBase("fx hit-spark"), "fx hit-spark glow");
  const info = { layers: [{ name: "AI: fx hit-spark" }, { name: "AI: fx burn 2 glow" }] };
  assert.equal(freeLayerName(info, "hit-spark"), "fx hit-spark 2");
  assert.equal(freeLayerName(info, "burn"), "fx burn", "a free name");
  assert.equal(freeLayerName({ layers: [{ name: "AI: fx burn" }, { name: "AI: fx burn 2 glow" }] }, "burn"), "fx burn 3", "the glow takes the name too");
  assert.ok(isFxLayerName("AI: fx torch") && !isFxLayerName("AI: normal"));
  assert.ok(isFxGlowName("AI: fx torch glow") && !isFxGlowName("AI: fx torch"));
});

test("the FX record: built with whole pixels, sent as wire params, parsed back; older records read the same", () => {
  const r = buildRecord({ id: "hit-spark", x: 10.4, y: 20.6, fps: 30, loop: false, windupMs: 33.3 });
  assert.deepEqual(r, { id: "hit-spark", x: 10, y: 21, fps: 30, loop: false, windupMs: 33 });
  assert.deepEqual(recordWire({ ...r, render: "{}" }), { id: "hit-spark", x: 10, y: 21, fps: 30, loop: false, windup_ms: 33, render: "{}" });
  assert.throws(() => buildRecord({ ...r, recipe: "x".repeat(16385) }), /at most 16384/);
  assert.deepEqual(["hit-spark", "recipe:a", "fluid:smoke", "pipeline:burn"].map((id) => recordKind({ id })), ["library", "recipe", "fluid", "pipeline"]);
  // A record from before recipe, render and windup (#71's first shape) still reads, renders and exports.
  const old = parseRecord({ id: "hit-spark", x: 32, y: 32, fps: 30, loop: false });
  assert.deepEqual(old, { id: "hit-spark", x: 32, y: 32, fps: 30, loop: false, windupMs: 0 });
  const st = parseState({ activeSprite: {
    width: 64, height: 64, frames: [{ durationMs: 100 }, { durationMs: 100 }],
    layers: [{ id: "L2", name: "AI: fx hit-spark", fx: { id: "hit-spark", x: 32, y: 32, fps: 30, loop: false } }],
    fxHits: [{ frame: 2, freezeMs: 80 }],
  } });
  assert.deepEqual(st.layers[0].fx, old);
  assert.deepEqual(st.hits, [{ frame: 2, freezeMs: 80 }]);
  const plan = fxExport(st);
  assert.deepEqual(plan.fx, { id: "hit-spark", fps: 30, loop: false, windup: 0, origin: { x: 32, y: 32 }, hits: [{ frame: 1, freeze_ms: 80 }] });
  assert.ok(!rerender(old, { sprite: { width: 64, height: 64 } }).onSprite, "a library record re-renders");
});

/** A 96x64 mage: a body and a staff whose tip thrusts forward on frame 4; an `attack` tag of irregular frames. */
function mage() {
  const durations = [120, 80, 60, 140, 60, 60];
  const body = durations.map(() => rect(96, 64, [14, 24, 25, 55], [70, 50, 120]));
  const staff = durations.map((_, i) => rect(96, 64, [26, 36, 30 + (i >= 3 ? 8 : 0), 37], [150, 110, 60]));
  return fakeDocument({
    width: 96, height: 64, durations, layer: "Staff", palette: ["#000000", "#ffffff", "#46327a", "#966e3c"],
    layers: [{ name: "Body", frames: body }, { name: "Staff", frames: staff }],
    tags: [{ name: "attack", from: 1, to: 6 }],
  });
}

test("the curated frost nova: a clustered flash, directional shards that lean forward, and an end that is empty", () => {
  const e = recipeEntry(parseRecipe(FROST_NOVA));
  const r = renderFx(e.module, {}, { fps: 30, seed: FROST_NOVA.seed });
  const side = (f) => {
    let back = 0, front = 0;
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (f.data[(y * f.width + x) * 4 + 3] >= 128) (x < r.origin.x ? back++ : front++);
    return { back, front };
  };
  // Clustered flash: the first frame is a tight core around the origin.
  const first = r.color[0];
  let far = 0;
  for (let y = 0; y < first.height; y++) for (let x = 0; x < first.width; x++) {
    if (first.data[(y * first.width + x) * 4 + 3] >= 128 && Math.hypot(x - r.origin.x, y - r.origin.y) > 8) far++;
  }
  assert.ok(opaque(first) > 20 && far === 0, `a clustered core (${opaque(first)} px, ${far} far)`);
  // Directional shards and asymmetric decay: the front holds more, longer; the back is gone first.
  const mid = side(r.color[6]), late = side(r.color[10]);
  assert.ok(mid.front > 2 * mid.back, `shards lean forward at 200 ms (${JSON.stringify(mid)})`);
  assert.ok(late.back === 0 && late.front > 0, `the back fades first (${JSON.stringify(late)})`);
  assert.equal(opaque(r.color.at(-1)), 0, "a one-shot that ends empty");
  assert.equal(opaque(renderFx(e.module, {}, { times: [FROST_NOVA.duration], seed: FROST_NOVA.seed }).color[0]), 0, "and empty at t = duration");
});

test("frost nova workflow: context preview and placement agree, check_fx judges the placed cels, hit-stop and export", async () => {
  // Context preview: nothing written, the frames and times it would use.
  const fake = mage();
  const at = { recipe: FROST_NOVA, tag: "attack", x: 38, y: 36, hit_frame: 4, seed: 11 };
  const pv = await run("fx_overlay", { ...at, preview: true }, fake);
  assert.ok(!pv.isError, textOf(pv));
  assert.deepEqual(writes(fake), [], "a preview changes nothing");
  assert.ok(pv.content.some((c) => c.type === "image"));
  const shown = /it would show on frames (\d+)-(\d+)/.exec(textOf(pv));
  assert.ok(shown, textOf(pv));
  assert.match(textOf(pv), /its impact \(\d+ ms in\) on frame 4/);

  // The default overflow on a tag cuts the fade: the last placed cel (frame 6, a 60 ms frame) still draws a
  // cluster, though the recipe itself ends empty at its duration. check_fx flags it on the placed cels.
  const r = await run("fx_overlay", at, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(writes(fake), ["put_images"], "one undo step");
  const placedOn = /it shows on frames (\d+)-(\d+)/.exec(textOf(r));
  assert.deepEqual(placedOn.slice(1), shown.slice(1), "the preview showed the frames it placed");
  const st = await state(fake);
  const layer = layerOf(st, "AI: fx recipe:frost-nova");
  assert.equal(JSON.parse(layer.fx.render).seed, 11, "fx_overlay records its render overrides (seed) like add_fx");
  assert.equal(JSON.parse(layer.fx.recipe).name, "frost-nova");
  assert.ok(opaque(fake.image("AI: fx recipe:frost-nova", 6)) > 8, "the cut leaves a cluster on the tag's last frame");
  const ck = textOf(await run("check_fx", { layer: "AI: fx recipe:frost-nova" }, fake));
  assert.match(ck, /warning one-shot-end \[L\d+ AI: fx recipe:frost-nova, frame 6\]: the one-shot still draws \d+ opaque px on the sprite's last frame \(6\)/);
  assert.doesNotMatch(ck, /at t = duration/, "the nominal end is empty: only the placed cels show the cut");

  // overflow 'extend' lets it fade on frames of its own: clean. Then a hit-stop and the export.
  const ok = mage();
  await run("fx_overlay", { ...at, overflow: "extend" }, ok);
  const ck2 = textOf(await run("check_fx", { layer: "AI: fx recipe:frost-nova" }, ok));
  assert.doesNotMatch(ck2, /one-shot-end/, ck2);
  assert.match(ck2, /0 errors/);
  assert.ok(!(await run("hit_stop", { frame: 4, freeze_ms: 90, shake: { amp: 1, ms: 40 } }, ok)).isError);
  const dir = mkdtempSync(join(tmpdir(), "fx97-"));
  const ex = await run("export_for_engine", { engine: "json", dir, name: "mage" }, ok);
  assert.ok(!ex.isError, textOf(ex));
  const meta = JSON.parse(readFileSync(join(dir, "mage.json"), "utf8")).meta.fx;
  assert.equal(meta.id, "recipe:frost-nova");
  assert.deepEqual(meta.hits.map((h) => [h.frame, h.freeze_ms]), [[3, 90]]);
});

test("add_fx preview shows the placement over the sprite and writes nothing; the same input then places it", async () => {
  const fake = mage();
  const input = { id: "hit-spark", x: 40, y: 36, start_frame: 2, palette: "sprite", seed: 3 };
  const pv = await run("add_fx", { ...input, preview: true }, fake);
  assert.ok(!pv.isError, textOf(pv));
  assert.deepEqual(writes(fake), []);
  assert.match(textOf(pv), /Preview of .* on frames 2-\d+.*Nothing changed\./);
  const r = await run("add_fx", input, fake);
  const a = /on frames (\d+-\d+)/.exec(textOf(pv))[1], b = /on frames (\d+-\d+)/.exec(textOf(r))[1];
  assert.equal(a, b);
});

test("originalFrame maps frames numbered after inserts back to the frame whose art they show", () => {
  const inserts = [{ after: 2, durations: [10, 10] }, { after: 4, durations: [10] }];
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((f) => originalFrame(inserts, f)), [1, 2, 2, 2, 3, 4, 4, 5]);
});

test("check_fx re-renders fluid records: a fluid near the edge spills, one from a layer cannot", async () => {
  const fake = fakeDocument({ width: 48, height: 48, durations: [100, 100, 100, 100], palette: ["#000000", "#ffffff", "#203040", "#8090a0"],
    layers: [{ name: "House", frames: [0, 1, 2, 3].map(() => rect(48, 48, [16, 30, 31, 47], [120, 60, 40])) }], layer: "House" });
  const r = await run("fluid_fx", { preset: "smoke-puff", apply: "layer", x: 2, y: 24, start_frame: 1, frames: 8, colors: "sprite" }, fake);
  assert.ok(!r.isError, textOf(r));
  const st = await state(fake);
  const fl = st.layers.find((l) => l.fx?.id === "fluid:smoke-puff");
  const settings = JSON.parse(fl.fx.render);
  assert.ok(Array.isArray(settings.colors) && settings.colors.every((c) => /^#[0-9a-f]{6}$/.test(c)), "a 'sprite' ramp is stored resolved");
  const ck = textOf(await run("check_fx", { layer: fl.name }, fake));
  assert.match(ck, /error spill .*fall outside the 48x48 sprite/, ck);
  // emit_layer draws on the sprite's own canvas: nothing to spill, and no edge guess either.
  assert.deepEqual(rerender({ id: "fluid:smoke", x: 0, y: 0, fps: 12, loop: true, windupMs: 0, render: JSON.stringify({ preset: "smoke", emit_layer: "House" }) },
    { sprite: { width: 48, height: 48 } }), { onSprite: true });
});

const PIPE_PALETTE = ["#000000", "#ffffff", "#d04648", "#223344", "#88aacc"];
const heroSprite = () => fakeDocument({
  width: 32, height: 32, durations: [100, 100, 100], layer: "Hero", palette: PIPE_PALETTE,
  layers: [{ name: "Hero", frames: [0, 1, 2].map(() => rect(32, 32, [12, 10, 19, 29], [208, 70, 72])) }],
});

test("check_fx re-renders pipeline records: a blank canvas placed half off the sprite spills; over a layer it cannot", async () => {
  const fake = heroSprite();
  const mist = { name: "mist", source: { w: 16, h: 16, x: -8, y: 8, frame: 1 }, frames: 3,
    steps: [{ type: "noise_fill", target: "canvas", cutoff: 0.2, ramp: ["#223344", "#88aacc"], noise: { scale: 4 } }] };
  assert.ok(!(await run("fx_pipeline", { pipeline: mist, apply: "layer" }, fake)).isError);
  const ck = textOf(await run("check_fx", { layer: "AI: fx mist" }, fake));
  assert.match(ck, /error spill \[L\d+ AI: fx mist\]: up to \d+ px of the effect fall outside the 32x32 sprite/, ck);
  const over = heroSprite();
  await run("fx_pipeline", { pipeline: { name: "edge", frames: { over: "all" }, steps: [{ type: "outline", color: -1 }] }, apply: "layer" }, over);
  const ck2 = textOf(await run("check_fx", { layer: "AI: fx edge" }, over));
  assert.doesNotMatch(ck2, /spill/, ck2);
});

test("fx_pipeline re-applied with the same name replaces its layer: same source, its frames reused, old pixels gone", async () => {
  const fake = heroSprite();
  const burn = { name: "burn", frames: 3, fps: 20, steps: [{ type: "outline" }, { type: "dissolve" }] };
  await run("fx_pipeline", { pipeline: burn, apply: "layer" }, fake);
  let st = await state(fake);
  assert.equal(st.frames.length, 6);
  // The effect layer is active now; a re-apply without a source still runs on Hero, over the same 3 frames.
  const fewer = { ...burn, frames: 2, steps: [{ type: "outline" }] };
  const r = await run("fx_pipeline", { pipeline: fewer, apply: "layer" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Pipeline burn on Hero \(replacing the earlier run on AI: fx burn\).*Reused the 3 frames the earlier run inserted \(2-4\); frames 4-4 now show Hero again/);
  st = await state(fake);
  assert.equal(st.frames.length, 6, "no frames inserted again");
  assert.deepEqual(st.layers.filter((l) => l.name.startsWith("AI: fx")).map((l) => l.name), ["AI: fx burn"], "one effect layer");
  const call = fake.calls.filter((c) => c.method === "put_images").at(-1);
  assert.equal(call.params.clear.length, 1, "the old layer is emptied in the same request");
  assert.equal(JSON.parse(layerOf(st, "AI: fx burn").fx.recipe).frames, 2);
  // Growing: the 2 frames the last run used are reused and 2 inserted after them (frame 4, left over from the
  // first run, is not on record any more and keeps showing Hero).
  const grow = await run("fx_pipeline", { pipeline: { ...burn, frames: 4 }, apply: "layer" }, fake);
  assert.match(textOf(grow), /Reused the 2 frames the earlier run inserted \(2-3\) and inserted 2 more/);
  assert.equal((await state(fake)).frames.length, 8);
  // replace: false keeps the old one and adds another layer.
  await run("fx_pipeline", { pipeline: { ...burn, source: "Hero" }, apply: "layer", replace: false }, fake);
  assert.deepEqual((await state(fake)).layers.filter((l) => l.name.startsWith("AI: fx")).map((l) => l.name).sort(), ["AI: fx burn", "AI: fx burn 2"]);
  // A blank-canvas pipeline re-applied keeps its place and leaves no stale cels.
  const c = heroSprite();
  const mist = (frames) => ({ name: "mist", source: { w: 8, h: 8, x: 2, y: 2, frame: 1 }, frames,
    steps: [{ type: "noise_fill", target: "canvas", cutoff: 0.1, ramp: ["#223344", "#88aacc"], noise: { scale: 3 } }] });
  await run("fx_pipeline", { pipeline: mist(3), apply: "layer" }, c);
  assert.ok(c.image("AI: fx mist", 3));
  await run("fx_pipeline", { pipeline: { ...mist(2), source: { w: 8, h: 8 } }, apply: "layer" }, c);
  assert.equal(c.image("AI: fx mist", 3), undefined, "frame 3 of the old run is gone");
  const rec = JSON.parse(layerOf(await state(c), "AI: fx mist").fx.recipe);
  assert.deepEqual([rec.source.x, rec.source.y, rec.source.frame], [2, 2, 1], "the earlier place and frame are kept");
});

test("the extension's document handlers see the FX record only as stored data (documentOf round trip)", async () => {
  const fake = mage();
  await run("add_fx", { id: "hit-spark", x: 40, y: 36, start_frame: 1, flip: true }, fake);
  const info = await documentOf(fake).info();
  const l = info.layers.find((x) => x.fx);
  assert.deepEqual(JSON.parse(l.fx.render), { flip: true });
  assert.equal(l.name, "AI: fx hit-spark");
});

test("the pixel-fx skill's frost nova is the curated recipe", () => {
  const skill = readFileSync(new URL("../../skills/pixel-fx/SKILL.md", import.meta.url), "utf8");
  const json = /A frost nova, as a starting point[^\n]*\n\s*```json\n([\s\S]*?)```/.exec(skill)[1];
  assert.deepEqual(parseRecipe(json), parseRecipe(FROST_NOVA));
});
