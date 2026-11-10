// FX library and tools (#69): the catalog, the time mapping, and list_fx / preview_fx / add_fx /
// new_fx_sprite on the fake document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { renderFx, visualCenter } from "../dist/fx/index.js";
import { FX_CATEGORIES, FX_LIBRARY, findFx, searchFx } from "../dist/fx/library.js";
import { fxAnchorPoint, fxCanvas, fxSchedule } from "../dist/fx_tools.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const lit = (im) => {
  const d = im.data ?? im;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
};
const same = (a, b) => Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette"]);

/** A 64x64 sprite with a Hero layer in every frame. */
function heroSprite(durations = [100]) {
  const body = rect(64, 64, [28, 24, 35, 47], [40, 60, 200]);
  return fakeDocument({ width: 64, height: 64, durations, layers: [{ name: "Hero", frames: durations.map(() => body) }], layer: "Hero" });
}
const layer = async (fake, name) => {
  const st = (await fake.request("get_state")).result.activeSprite;
  const all = [];
  const walk = (ls) => ls.forEach((l) => { all.push(l); if (l.layers) walk(l.layers); });
  walk(st.layers);
  return all.find((l) => l.name === name);
};

test("the library: about 40 effects in the asked categories, from each effect's own meta", () => {
  assert.ok(FX_LIBRARY.length >= 38 && FX_LIBRARY.length <= 46, `${FX_LIBRARY.length} effects`);
  for (const c of ["impacts", "melee", "explosions", "lightning", "arcane", "holy", "fire"]) {
    assert.ok(FX_LIBRARY.filter((e) => e.category === c).length >= 4, c);
  }
  assert.deepEqual(FX_CATEGORIES.filter((c) => !FX_LIBRARY.some((e) => e.category === c)), []);
  assert.equal(new Set(FX_LIBRARY.map((e) => e.id)).size, FX_LIBRARY.length, "ids are unique");
  const spark = findFx("Hit_Spark");
  assert.equal(spark.id, "hit-spark");
  assert.equal(spark.loop, false);
  assert.equal(spark.durationMs, 500);
  assert.deepEqual(spark.size, { width: 136, height: 80 });
  assert.deepEqual(spark.origin, { x: 44, y: 64 });
  assert.ok(spark.palette.length > 2 && spark.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
  assert.ok(spark.options.some((o) => o.name === "height"));
  assert.ok(!spark.options.some((o) => o.name === "seed" || o.name === "palette"));
  assert.ok(FX_LIBRARY.some((e) => e.loop) && FX_LIBRARY.some((e) => !e.loop));
  assert.ok(FX_LIBRARY.every((e) => !e.module.meta.actor), "no entry needs an actor");
  assert.deepEqual(searchFx({ category: "fire", loop: true }).map((e) => e.category === "fire" && e.loop), searchFx({ category: "fire", loop: true }).map(() => true));
  assert.ok(searchFx({ query: "slash" }).some((e) => e.id === "sword-slash"));
});

test("every effect renders; one-shots end empty and loops wrap", () => {
  for (const e of FX_LIBRARY) {
    const r = renderFx(e.module, {}, { times: [0, e.durationMs / 2000, e.durationMs / 1000], seed: e.seed });
    assert.ok(r.frames.some((f) => lit(f) > 0), `${e.id} draws something`);
    if (e.loop) assert.ok(same(r.frames[0], r.frames[2]), `${e.id}: the frame at its duration is its first frame`);
    else assert.equal(lit(r.frames[2]), 0, `${e.id}: nothing left at its duration`);
  }
});

test("renderFx at times matches renderFx at fps, and gives color without light", () => {
  const e = findFx("hit-spark");
  const byFps = renderFx(e.module, {}, { fps: 30, seed: 2 });
  const at = renderFx(e.module, {}, { times: [0.1, 0, 0.1], seed: 2 });
  assert.ok(same(at.frames[1], byFps.frames[0]) && same(at.frames[0], byFps.frames[3]) && same(at.frames[2], byFps.frames[3]));
  const i = byFps.glow.findIndex((g) => lit(g) > 0);
  assert.ok(i >= 0, "the spark has light");
  assert.ok(lit(byFps.color[i]) <= lit(byFps.frames[i]), "the color alone covers no more than color plus light");
});

test("fxSchedule maps sprite frames to effect times by duration, adding frames past the end", () => {
  // A one-shot over a 1-frame sprite of 100 ms: then 33 ms frames until 500 ms.
  const one = fxSchedule([100], 1, 500, false, 33);
  assert.equal(one.samples.length, 14);
  assert.equal(one.frames, 14);
  assert.deepEqual(one.samples.slice(0, 3), [{ frame: 1, t: 0 }, { frame: 2, t: 100 }, { frame: 3, t: 133 }]);
  // Shorter than the sprite: no frames added, from start_frame.
  const short = fxSchedule([100, 100, 100, 100, 100, 100, 100, 100], 3, 250, false, 33);
  assert.deepEqual(short.samples, [{ frame: 3, t: 0 }, { frame: 4, t: 100 }, { frame: 5, t: 200 }]);
  assert.equal(short.frames, 8);
  // A loop wraps over every frame to the end...
  const loop = fxSchedule([500, 500, 500, 500, 500, 500], 1, 2000, true, 33);
  assert.deepEqual(loop.samples.map((s) => s.t), [0, 500, 1000, 1500, 0, 500]);
  assert.equal(loop.frames, 6);
  // ...and covers at least one whole loop.
  const grow = fxSchedule([400], 1, 1000, true, 200);
  assert.deepEqual(grow.samples.map((s) => s.t), [0, 400, 600, 800]);
  assert.equal(grow.frames, 4);
});

test("fxCanvas mirrors the origin when flipped and makes room to turn", () => {
  const e = findFx("hit-spark");
  assert.deepEqual(fxCanvas(e, false, 0), { width: 136, height: 80, x: 44, y: 64 });
  assert.deepEqual(fxCanvas(e, true, 0), { width: 136, height: 80, x: 92, y: 64 });
  const turned = fxCanvas(e, false, 45);
  assert.equal(turned.width, turned.height);
  assert.ok(turned.width >= 2 * Math.hypot(92, 64));
});

test("add_fx: a hit spark on a 64x64 sprite, glow on an Addition layer, frames added, one request", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", x: 36, y: 40, anchor: "ground" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /frames 1-14 \(13 frames added, 33 ms each\).*One undo step/);
  const writes = fake.calls.filter((c) => WRITES.has(c.method));
  assert.deepEqual(writes.map((c) => c.method), ["put_images"], "one write: one undo step");
  assert.deepEqual(fake.layerNames(), ["Hero", "AI: fx hit-spark", "AI: fx hit-spark glow"]);
  const st = (await fake.request("get_state")).result.activeSprite;
  assert.equal(st.frames.length, 14);
  assert.deepEqual(st.frames.map((f) => f.durationMs), [100, ...Array(13).fill(33)]);
  assert.equal((await layer(fake, "AI: fx hit-spark glow")).blendMode, "addition");
  assert.equal((await layer(fake, "AI: fx hit-spark")).blendMode, "normal");
  // The hero stays in the new frames; the spark is drawn and fades out.
  assert.ok(fake.images("Hero").every((im) => im && lit(im) > 0));
  assert.ok(lit(fake.image("AI: fx hit-spark", 1)) > 0);
  const glow = fake.images("AI: fx hit-spark glow");
  assert.ok(glow.some((g) => g && lit(g) > 0), "the glow layer has light");
  // The colors match a render at the same times, placed with the origin at (36, 40).
  const e = findFx("hit-spark");
  const ref = renderFx(e.module, {}, { times: [0], seed: e.seed });
  const c = ref.color[0], at = fake.image("AI: fx hit-spark", 1);
  let checked = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const sx = 36 - 44 + x, sy = 40 - 64 + y;
    if (sx < 0 || sy < 0 || sx >= 64 || sy >= 64) continue;
    const i = (y * c.width + x) * 4, j = (sy * 64 + sx) * 4;
    if (!c.data[i + 3]) { assert.equal(at[j + 3], 0); continue; }
    assert.deepEqual([...at.subarray(j, j + 4)], [...c.data.subarray(i, i + 4)]);
    checked++;
  }
  assert.ok(checked > 10, "compared the spark's pixels");
});

test("add_fx: a one-shot shorter than the sprite leaves the later frames empty; nothing is added", async () => {
  const fake = heroSprite(Array(10).fill(100));
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", x: 32, y: 40, start_frame: 2, glow: "baked" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.equal((await fake.request("get_state")).result.activeSprite.frames.length, 10);
  assert.deepEqual(fake.layerNames(), ["Hero", "AI: fx hit-spark"], "baked: no glow layer");
  const cels = fake.images("AI: fx hit-spark").map((im) => !!im && lit(im) > 0);
  // Frames 2-6 show it at 0-400 ms (it may have faded by then); frames 7-10 are past its 500 ms.
  assert.deepEqual(cels.slice(0, 3), [false, true, true]);
  assert.deepEqual(cels.slice(6), [false, false, false, false]);
  // A second one gets its own layer instead of overwriting the first.
  await runTool(findTool("add_fx"), { id: "hit-spark", x: 10, y: 10, glow: "none" }, fake);
  assert.deepEqual(fake.layerNames(), ["Hero", "AI: fx hit-spark", "AI: fx hit-spark 2"]);
});

test("add_fx: a loop wraps over the sprite's frames", async () => {
  const fake = heroSprite(Array(6).fill(500));
  const r = await runTool(findTool("add_fx"), { id: "torch", x: 32, y: 60, start_frame: 1, glow: "none" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /frames 1-6, looping/);
  const f = fake.images("AI: fx torch");
  assert.ok(f.every((im) => im && lit(im) > 0));
  assert.ok(same({ data: f[0] }, { data: f[4] }), "frame 5 (t = 2 s) is frame 1 again");
  assert.ok(!same({ data: f[0] }, { data: f[1] }));
});

test("add_fx: slices, palette snapping, flip and bad input", async () => {
  const fake = fakeDocument({
    width: 64, height: 64, layers: [{ name: "Hero", frames: [rect(64, 64, [0, 0, 1, 1], [0, 0, 0])] }], layer: "Hero",
    palette: ["#000000", "#ffffff", "#ffcc00"], slices: [{ name: "hit", bounds: { x: 40, y: 20, width: 8, height: 8 } }],
  });
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", slice: "hit", palette: "sprite", flip: true, glow: "baked" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /visual centre at 44,24 \(anchor center\)/);
  const colors = new Set();
  for (const im of fake.images("AI: fx hit-spark")) {
    if (!im) continue;
    for (let i = 0; i < im.length; i += 4) if (im[i + 3] >= 128) colors.add([im[i], im[i + 1], im[i + 2]].join());
  }
  assert.ok([...colors].every((c) => ["0,0,0", "255,255,255", "255,204,0"].includes(c)), [...colors].join(" "));
  assert.match(textOf(await runTool(findTool("add_fx"), { id: "nope" }, fake)), /No effect named 'nope'/);
  assert.match(textOf(await runTool(findTool("add_fx"), { id: "hit-spark", options: { colour: 1 } }, fake)), /has no option 'colour'/);
  assert.match(textOf(await runTool(findTool("add_fx"), { id: "hit-spark", slice: "x" }, fake)), /No slice named x/);
  assert.match(textOf(await runTool(findTool("add_fx"), { id: "hit-spark", x: 500, y: 500 }, fake)), /lands outside/);
});

/** The alpha-weighted centroid of the busiest image (largest alpha sum), as visualCenter computes it. */
function busiestCentroid(images, width) {
  let best, bestSum = 0;
  for (const im of images) {
    if (!im) continue;
    let s = 0;
    for (let i = 3; i < im.length; i += 4) s += im[i];
    if (s > bestSum) { bestSum = s; best = im; }
  }
  let sx = 0, sy = 0;
  for (let i = 3; i < best.length; i += 4) { const p = (i - 3) / 4; sx += best[i] * (p % width); sy += best[i] * Math.floor(p / width); }
  return { x: sx / bestSum, y: sy / bestSum };
}

test("add_fx anchors: 'center' puts the visual centre at x, y; 'ground' puts the origin there", async () => {
  // 33 ms frames sample the effect at its own 30 fps steps, so the sprite shows the frames visualCenter saw.
  const sprite = () => fakeDocument({ width: 200, height: 200, durations: Array(15).fill(33), layers: [{ name: "Bg", frames: Array(15).fill(undefined) }] });
  const e = findFx("hit-spark");
  assert.equal(e.anchor, "center");
  const c = fxAnchorPoint(e, "center", {}, e.seed, fxCanvas(e, false, 0));
  assert.deepEqual(c, visualCenter(renderFx(e.module, {}, { fps: e.fps, seed: e.seed }).frames));
  assert.ok(e.origin.y - c.y > 10, `the flash sits well above the ground point (${c.x},${c.y} vs ${e.origin.x},${e.origin.y})`);

  const centred = sprite();
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", x: 100, y: 100, glow: "baked" }, centred);
  assert.match(textOf(r), /visual centre at 100,100 \(anchor center\)/);
  const at = busiestCentroid(centred.images("AI: fx hit-spark"), 200);
  assert.ok(Math.abs(at.x - 100) <= 1 && Math.abs(at.y - 100) <= 1, `centroid ${at.x},${at.y}`);

  const grounded = sprite();
  await runTool(findTool("add_fx"), { id: "hit-spark", x: 100, y: 100, glow: "baked", anchor: "ground" }, grounded);
  const g = busiestCentroid(grounded.images("AI: fx hit-spark"), 200);
  assert.ok(Math.abs(g.x - (100 + c.x - e.origin.x)) <= 1 && Math.abs(g.y - (100 + c.y - e.origin.y)) <= 1, `centroid ${g.x},${g.y}`);

  // Defaults: floor effects stand on x, y; hits, slashes and floating effects are centred there.
  for (const id of ["torch", "campfire", "flame-pillar", "holy-pillar", "ground-slam", "heavy-landing", "small-explosion", "meteor", "lightning-strike"]) {
    assert.equal(findFx(id).anchor, "ground", id);
  }
  for (const id of ["hit-spark", "crit-hit", "ricochet", "sword-slash", "heavy-cleave", "plasma-explosion", "chain-lightning", "arcane-orb"]) {
    assert.equal(findFx(id).anchor, "center", id);
  }
  assert.match(textOf(await runTool(findTool("list_fx"), { query: "torch" }, grounded)), /anchor ground/);
  assert.match(textOf(await runTool(findTool("preview_fx"), { id: "hit-spark" }, grounded)), new RegExp(`visual centre at ${c.x},${c.y}.*anchor center`));
});

test("add_fx appends the effect's colors to the sprite palette in the same write, but not the glow's", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", x: 32, y: 32 }, fake);
  assert.ok(!r.isError, textOf(r));
  const writes = fake.calls.filter((c) => WRITES.has(c.method));
  assert.deepEqual(writes.map((c) => c.method), ["put_images"], "one write: one undo step");
  const sent = writes[0].params.palette;
  assert.ok(sent.length > 0 && sent.every((h) => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(sent));
  const colors = (img) => {
    const s = new Set();
    for (const im of img) if (im) for (let i = 0; i < im.length; i += 4) if (im[i + 3]) s.add("#" + [im[i], im[i + 1], im[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""));
    return s;
  };
  const pal = (await fake.request("get_palette")).result.colors;
  assert.equal(pal.length, 2 + sent.length);
  const used = colors(fake.images("AI: fx hit-spark"));
  assert.ok([...used].every((h) => pal.includes(h)), "every color on the effect layer is in the palette");
  assert.deepEqual(new Set(sent), new Set([...used].filter((h) => h !== "#000000" && h !== "#ffffff")), "only the colors it lacked");
  assert.match(textOf(r), new RegExp(`Added its ${sent.length} colors to the sprite palette \\(${pal.length} entries\\)`));
  // A second one adds nothing new.
  const again = await runTool(findTool("add_fx"), { id: "hit-spark", x: 20, y: 20, glow: "none" }, fake);
  assert.match(textOf(again), /already in the sprite palette/);
  assert.equal((await fake.request("get_palette")).result.colors.length, pal.length);
  // 'sprite' and a ramp leave the palette alone.
  await runTool(findTool("add_fx"), { id: "hit-spark", palette: ["#220000", "#ff0000"], glow: "none" }, fake);
  assert.equal(fake.calls.filter((c) => c.method === "put_images").at(-1).params.palette, undefined);
});

test("add_fx snaps to the sprite palette instead when appending would pass 256 entries", async () => {
  const greys = Array.from({ length: 254 }, (_, i) => "#" + [i, i, (i + 1) % 256].map((v) => v.toString(16).padStart(2, "0")).join(""));
  const fake = fakeDocument({ width: 64, height: 64, palette: greys, layers: [{ name: "Hero", frames: [rect(64, 64, [0, 0, 1, 1], [0, 0, 1])] }], layer: "Hero" });
  const r = await runTool(findTool("add_fx"), { id: "hit-spark", x: 32, y: 32 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /past 256 entries \(it has 254\), so they were snapped to the sprite palette instead/);
  assert.equal(fake.calls.find((c) => c.method === "put_images").params.palette, undefined);
  const pal = new Set((await fake.request("get_palette")).result.colors);
  assert.equal(pal.size, 254);
  for (const im of fake.images("AI: fx hit-spark")) {
    if (!im) continue;
    for (let i = 0; i < im.length; i += 4) {
      if (im[i + 3]) assert.ok(pal.has("#" + [im[i], im[i + 1], im[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")));
    }
  }
});

test("preview_fx: a numbered contact sheet PNG, nothing written", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("preview_fx"), { id: "sword-slash", frames: 8, zoom: 1 }, fake);
  assert.ok(!r.isError, textOf(r));
  const img = r.content.find((c) => c.type === "image");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  assert.ok(png.width > 100 && png.height > 20);
  assert.match(textOf(r), /showing 8/);
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);
});

test("new_fx_sprite: the effect as its own tagged sprite at 1000/fps ms a frame", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("new_fx_sprite"), { id: "hit-spark", fps: 20 }, fake);
  assert.ok(!r.isError, textOf(r));
  const st = (await fake.request("get_state")).result.activeSprite;
  assert.equal(st.width, 136);
  assert.equal(st.frames.length, 11);
  assert.ok(st.frames.every((f) => f.durationMs === 50));
  assert.deepEqual(st.tags.map((t) => [t.name, t.from, t.to]), [["hit-spark", 1, 11]]);
  const frames = fake.images("Layer 1");
  assert.ok(lit({ data: frames[0] }) > 0);
  assert.equal(lit({ data: frames.at(-1) }), 0, "a one-shot ends on an empty frame");
  // Its baked glow has thousands of colors: the palette holds 256 and every pixel is one of them.
  assert.match(textOf(r), /colors reduced to \d+ and the frames snapped/);
  const pal = new Set((await fake.request("get_palette")).result.colors);
  assert.ok(pal.size > 16 && pal.size <= 256, `${pal.size} colors`);
  for (const im of frames) {
    for (let i = 0; i < im.length; i += 4) {
      if (im[i + 3]) assert.ok(pal.has("#" + [im[i], im[i + 1], im[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")));
    }
  }
});

test("list_fx filters by words, category and loop", async () => {
  const fake = heroSprite();
  const all = textOf(await runTool(findTool("list_fx"), {}, fake));
  assert.match(all, new RegExp(`^${FX_LIBRARY.length} effects:`));
  const fire = textOf(await runTool(findTool("list_fx"), { category: "fire", loop: true }, fake));
  assert.match(fire, /torch: Torch \(fire, loop/);
  assert.doesNotMatch(fire, /one-shot/);
  assert.match(textOf(await runTool(findTool("list_fx"), { category: "water" }, fake)), /No category 'water'/);
});
