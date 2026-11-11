// Effect pipelines (#107): the noise module (determinism, ranges, loop wrap, curl), each pipeline step on small
// images, palette-only output, schema messages by path, and fx_pipeline on the fake document (preview writes
// nothing; apply is one put_images request with the pipeline stored as the layer's FX record).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOISE_KINDS, Noise, curl2, fbm, field, loopNoise } from "../dist/sprite_fx/noise.js";
import { STEP_TYPES, animAt, euclideanDistance, gridDistance, parsePipeline, registerStep, runPipeline } from "../dist/sprite_fx/pipeline.js";
import { findTool, runTool } from "../dist/tools.js";
import { documentOf } from "../dist/document.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";
import * as z from "zod/v4";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette"]);
const img = (w, h, r, c) => ({ width: w, height: h, data: rect(w, h, r, c) });
const lit = (im) => { let n = 0; for (let i = 3; i < im.data.length; i += 4) if (im.data[i]) n++; return n; };
const at = (im, x, y) => { const i = (y * im.width + x) * 4; return im.data[i + 3] ? [im.data[i], im.data[i + 1], im.data[i + 2]] : null; };
const colors = (im) => {
  const s = new Set();
  for (let i = 0; i < im.data.length; i += 4) if (im.data[i + 3]) s.add(`${im.data[i]},${im.data[i + 1]},${im.data[i + 2]}`);
  return s;
};
const same = (a, b) => Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const RGB = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: 255 });
const PALETTE = ["#140c1c", "#442434", "#854c30", "#d04648", "#d27d2c", "#dad45e", "#deeed6"];
const PAL = PALETTE.map(RGB);
const allowed = new Set([...PALETTE.map((h) => RGB(h)).map((c) => `${c.r},${c.g},${c.b}`)]);
/** A 24x24 red block: the shape most steps run on. */
const block = () => img(24, 24, [8, 6, 15, 17], [208, 70, 72]);
const run = (steps, extra = {}, sources) => {
  const p = parsePipeline({ name: "t", frames: 4, ...extra, steps });
  return runPipeline(p, sources ?? Array.from({ length: typeof p.frames === "number" ? p.frames : 4 }, block), PAL);
};
const onPalette = (frames) => frames.every((f) => [...colors(f)].every((c) => allowed.has(c)));

test("noise: every kind is seeded, deterministic and in [-1, 1] in 2D, 3D and 4D", () => {
  const a = new Noise(7), b = new Noise(7), c = new Noise(8);
  for (const k of NOISE_KINDS) {
    let lo = 9, hi = -9, differ = 0;
    for (let i = 0; i < 3000; i++) {
      const x = i * 0.173, y = i * 0.091, z = i * 0.037, w = i * 0.013;
      for (const v of [a.sample(k, x, y), a.sample(k, x, y, z), a.sample(k, x, y, z, w)]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      assert.equal(a.sample(k, x, y, z), b.sample(k, x, y, z), `${k} same seed`);
      if (a.sample(k, x, y) !== c.sample(k, x, y)) differ++;
    }
    assert.ok(lo >= -1.0001 && hi <= 1.0001, `${k} range ${lo}..${hi}`);
    assert.ok(hi - lo > 1, `${k} uses its range (${lo}..${hi})`);
    assert.ok(differ > 2500, `${k}: another seed is another field`);
  }
  // Coherent: neighbours are close (not white noise).
  const n = new Noise(1);
  for (const k of ["value", "perlin", "simplex"]) assert.ok(Math.abs(n.sample(k, 3.2, 4.1) - n.sample(k, 3.21, 4.1)) < 0.05, k);
  assert.ok(Math.abs(fbm(n, "simplex", 1.3, 2.2, undefined, undefined, { octaves: 4 })) <= 1);
});

test("noise: looping noise wraps exactly (phase 1 = phase 0) and moves in between; curl is divergence-free", () => {
  const n = new Noise(3);
  for (const k of NOISE_KINDS) {
    for (const [x, y] of [[0.3, 0.7], [5.1, 2.9], [11.2, 8.4]]) {
      assert.ok(Math.abs(loopNoise(n, k, x, y, 0, 1.5, { octaves: 3 }) - loopNoise(n, k, x, y, 1, 1.5, { octaves: 3 })) < 1e-9, `${k} wraps`);
    }
    let moved = 0;
    for (let i = 0; i < 20; i++) if (Math.abs(field(n, k, i * 3, i * 2, 6, { t: 0, loop: true, speed: 3 }) - field(n, k, i * 3, i * 2, 6, { t: 0.5, loop: true, speed: 3 })) > 1e-3) moved++;
    assert.ok(moved > 10, `${k} changes over the loop`);
  }
  // Divergence of the curl field by central differences is ~0.
  const e = 1e-3, div = (x, y) => (curl2(n, "simplex", x + e, y, 0.5)[0] - curl2(n, "simplex", x - e, y, 0.5)[0] + curl2(n, "simplex", x, y + e, 0.5)[1] - curl2(n, "simplex", x, y - e, 0.5)[1]) / (2 * e);
  for (const [x, y] of [[0.4, 0.2], [3.3, 1.7], [7.7, 9.1]]) assert.ok(Math.abs(div(x, y)) < 0.05, `div ${div(x, y)}`);
});

test("animated params: tweens, eases and keyframes", () => {
  assert.equal(animAt(3, 0.4), 3);
  assert.equal(animAt({ from: 0, to: 10 }, 0.5), 5);
  assert.equal(animAt({ from: 0, to: 10, ease: "in_quad" }, 0.5), 2.5);
  const k = { keys: [[0, 0], [0.5, 10], [1, 4]] };
  assert.equal(animAt(k, 0.25), 5);
  assert.equal(animAt(k, 0.75), 7);
  assert.equal(animAt(k, 1), 4);
});

test("distances: grid (4/8 neighbours) and exact Euclidean", () => {
  const seed = (i) => i === 2 * 5 + 2;
  const g4 = gridDistance(5, 5, seed, 4), g8 = gridDistance(5, 5, seed, 8), e = euclideanDistance(5, 5, seed);
  assert.equal(g4.d[0], 4);
  assert.equal(g8.d[0], 2);
  assert.ok(Math.abs(e[0] - Math.SQRT2 * 2) < 1e-9);
  assert.equal(g4.from[0], 12);
});

test("outline: outer around the shape, thickness and 4/8 neighbours; inner recolors the edge only", () => {
  const [o1] = run([{ type: "outline" }]).frames;
  assert.deepEqual(at(o1, 7, 10), [20, 12, 28], "darkest palette color left of the block");
  assert.equal(at(o1, 7, 5), null, "4-neighbour: no diagonal corner");
  const [o8] = run([{ type: "outline", neighbors: 8, thickness: 2, color: -1 }]).frames;
  assert.deepEqual(at(o8, 7, 5), [222, 238, 214]);
  assert.deepEqual(at(o8, 6, 10), [222, 238, 214], "two pixels thick");
  const [inner] = run([{ type: "outline", mode: "inner", color: "#140c1c" }]).frames;
  assert.deepEqual(at(inner, 8, 10), [20, 12, 28]);
  assert.deepEqual(at(inner, 10, 10), [208, 70, 72], "inside stays");
  assert.equal(lit(inner), lit(block()), "inner adds no pixels");
  // Animated thickness grows over the frames.
  const grow = run([{ type: "outline", thickness: { from: 1, to: 3 } }]).frames.map(lit);
  assert.ok(grow[0] < grow[3], JSON.stringify(grow));
});

test("dissolve: the threshold is the fraction gone, with a lighter edge band; ends empty", () => {
  const frames = run([{ type: "dissolve", edge: 0.15 }], { frames: 5 }).frames;
  const full = lit(block());
  assert.equal(lit(frames[0]), full, "t = 0: nothing gone");
  assert.ok(Math.abs(lit(frames[2]) - full / 2) <= 2, `half gone at t = 0.5 (${lit(frames[2])} of ${full})`);
  assert.equal(lit(frames[4]), 0, "t = 1: all gone");
  assert.ok(colors(frames[2]).has("210,125,44"), "the edge band is one palette step lighter (#d27d2c)");
  // A dissolving pixel never comes back.
  for (let i = 0; i + 1 < frames.length; i++) for (let p = 3; p < frames[i].data.length; p += 4) if (!frames[i].data[p]) assert.equal(frames[i + 1].data[p], 0);
});

test("displace: noise and wave move pixels with nearest sampling (no new colors); amount 0 is a no-op", () => {
  const src = block();
  const [still] = run([{ type: "displace", amount: 0 }]).frames;
  assert.ok(same(still, src));
  const wave = run([{ type: "displace", mode: "wave", amount: 2, wavelength: 6 }]).frames;
  assert.ok(!same(wave[1], src));
  assert.deepEqual([...colors(wave[1])], ["208,70,72"]);
  const noisy = run([{ type: "displace", amount: 3, noise: { kind: "perlin", scale: 4 } }], { loop: true }).frames;
  assert.deepEqual([...colors(noisy[2])], ["208,70,72"]);
});

test("gradient_map maps lightness to the ramp; glow grows the mask by radius with a ramp, behind the shape", () => {
  const two = img(16, 16, [8, 2, 13, 7], [230, 230, 230]);
  for (let y = 2; y <= 7; y++) for (let x = 2; x <= 7; x++) two.data.set([40, 40, 40, 255], (y * 16 + x) * 4);
  const [g] = run([{ type: "gradient_map", ramp: ["#000080", "#ff8000"] }], { frames: 1 }, [two]).frames;
  assert.deepEqual(at(g, 3, 3), [0, 0, 128]);
  assert.deepEqual(at(g, 10, 3), [255, 128, 0]);
  const [glow] = run([{ type: "glow", radius: 3, ramp: ["#deeed6", "#dad45e", "#d27d2c"] }], { frames: 1 }, [block()]).frames;
  assert.deepEqual(at(glow, 7, 10), [222, 238, 214], "inner band next to the shape");
  assert.deepEqual(at(glow, 5, 10), [210, 125, 44], "outer band 3 px away");
  assert.equal(at(glow, 4, 10), null, "nothing past the radius");
  assert.deepEqual(at(glow, 10, 10), [208, 70, 72], "the shape stays on top");
  assert.equal(at(glow, 5, 3), null, "round: no square corner at (3, 3) away");
});

test("noise_fill fills the mask or the canvas with quantized ramp colors; palette_map snaps to given colors", () => {
  const [m] = run([{ type: "noise_fill", ramp: ["#140c1c", "#854c30", "#dad45e"], noise: { scale: 3 } }], { frames: 1 }).frames;
  assert.equal(lit(m), lit(block()), "mask: same pixels");
  assert.ok(colors(m).size >= 2);
  const blankSrc = { width: 20, height: 20, data: new Uint8Array(20 * 20 * 4) };
  const [c] = run([{ type: "noise_fill", target: "canvas", cutoff: 0.5, levels: 2 }], { frames: 1, source: { w: 20, h: 20 } }, [blankSrc]).frames;
  assert.ok(lit(c) > 0 && lit(c) < 400, `canvas with a cutoff: some empty (${lit(c)})`);
  assert.ok(colors(c).size <= 2);
  const [pm] = run([{ type: "palette_map", colors: ["#000000", "#ffffff"] }], { frames: 1 }).frames;
  assert.deepEqual([...colors(pm)], ["255,255,255"], "nearest in OKLab: the red is closer to white");
  const grad = img(16, 4, [0, 0, 15, 3], [0, 0, 0]);
  for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) grad.data.set([x * 16, x * 16, x * 16, 255], (y * 16 + x) * 4);
  const [d] = run([{ type: "palette_map", colors: ["#000000", "#ffffff"], dither: "bayer4" }], { frames: 1 }, [grad]).frames;
  assert.equal(colors(d).size, 2, "dithered between the two");
});

test("juice, flash, tint and offset steps", () => {
  const frames = run([{ type: "juice", effect: "shake", px: 3 }], { frames: 4 }).frames;
  assert.ok(frames.some((f) => !same(f, block())), "shake moves the art");
  const fl = run([{ type: "flash", amount: { from: 1, to: 0 } }], { frames: 3 }).frames;
  assert.deepEqual([...colors(fl[0])], ["255,255,255"]);
  assert.equal(colors(fl[1]).size, 2, "half flashed in a Bayer pattern");
  assert.deepEqual([...colors(fl[2])], ["208,70,72"]);
  const [ti] = run([{ type: "tint", color: "#deeed6", amount: 1 }], { frames: 1 }).frames;
  assert.deepEqual([...colors(ti)], ["222,238,214"]);
  const off = run([{ type: "offset", x: { from: 0, to: 3 } }], { frames: 4 }).frames;
  assert.deepEqual(at(off[3], 11, 6), [208, 70, 72]);
  assert.equal(at(off[3], 8, 6), null);
});

test("every step writes palette colors only, and a pipeline is deterministic", () => {
  const steps = [
    { type: "displace", amount: 2 }, { type: "gradient_map" }, { type: "outline", color: "selout" }, { type: "glow", radius: 2 },
    { type: "noise_fill", target: "mask", cutoff: 0.6 }, { type: "dissolve", threshold: { from: 0, to: 0.5 } },
    { type: "tint", color: 2, amount: 0.4, dither: "bayer4" }, { type: "juice", effect: "wobble" }, { type: "offset", y: -1 },
  ];
  const a = run(steps, { loop: true, seed: 5 }), b = run(steps, { loop: true, seed: 5 });
  assert.ok(onPalette(a.frames), [...a.frames.flatMap((f) => [...colors(f)])].filter((c) => !allowed.has(c)).join(" "));
  assert.ok(a.frames.every((f, i) => same(f, b.frames[i])));
  for (const f of a.frames) for (let i = 3; i < f.data.length; i += 4) assert.ok(f.data[i] === 0 || f.data[i] === 255, "alpha is 0 or 255");
  assert.deepEqual(a.added, []);
  // A color the steps name that the palette lacks is reported to append.
  assert.deepEqual(run([{ type: "flash" }], { frames: 1 }).added, ["#ffffff"]);
});

test("the step registry is the extension point: a registered step is accepted and runs", () => {
  registerStep({ type: "test_clear", what: "test", schema: z.object({}).strict(), run: (im) => ({ ...im, data: new Uint8Array(im.data.length) }) });
  try {
    assert.equal(lit(run([{ type: "test_clear" }], { frames: 1 }).frames[0]), 0);
  } finally {
    STEP_TYPES.delete("test_clear");
  }
});

test("the schema rejects bad pipelines and says where and why", () => {
  let msg = "";
  try {
    parsePipeline({ name: "Bad", frames: 99, source: { w: 999, h: 4 }, palette: ["red"], steps: [
      { type: "outline", thickness: 12, mode: "middle" }, { type: "boom" }, { type: "dissolve", threshold: { from: 0, to: 3 } },
      { type: "glow", radius: { keys: [[0, 1]] } }, { type: "offset", x: "a", bogus: 1 }, { type: "tint" },
    ] });
  } catch (e) { msg = e.message; }
  assert.match(msg, /^The pipeline has problems:/);
  assert.match(msg, /- name: name is 1-40 lowercase letters/);
  assert.match(msg, /- source\.w: w must be at most 256/);
  assert.match(msg, /- frames: frames must be at most 48/);
  assert.match(msg, /- palette\.0: a color is '#rrggbb'/);
  assert.match(msg, /- steps\.0\.thickness: thickness must be at most 8/);
  assert.match(msg, /- steps\.0\.mode: mode must be 'outer' or 'inner'/);
  assert.match(msg, /- steps\.1\.type: type must be one of outline, dissolve, displace, gradient_map, glow, noise_fill, palette_map, juice, flash, tint, offset/);
  assert.match(msg, /- steps\.2\.threshold\.to: threshold must be at most 1/);
  try { parsePipeline({ name: "a", steps: [{ type: "glow", radius: { keys: [[0, 1]] } }, { type: "offset", x: "a", bogus: 1 }, { type: "tint" }] }); } catch (e) { msg = e.message; }
  assert.match(msg, /- steps\.0\.radius\.keys: radius needs at least 2 keys/);
  assert.match(msg, /- steps\.1\.x: x must be a number, \{ from, to, ease\? \} or \{ keys/);
  assert.match(msg, /- steps\.1: Unrecognized key: "bogus"/);
  assert.match(msg, /- steps\.2\.color: color is a palette step/);
  try { parsePipeline("{ nope"); } catch (e) { msg = e.message; }
  assert.match(msg, /not valid JSON/);
  try { parsePipeline({ name: "a", steps: [] }); } catch (e) { msg = e.message; }
  assert.match(msg, /- steps: a pipeline needs at least one step/);
});

function sprite() {
  return fakeDocument({
    width: 32, height: 32, durations: [100, 100, 100], layer: "Hero", palette: PALETTE,
    layers: [
      { name: "BG", frames: [0, 1, 2].map(() => rect(32, 32, [0, 0, 31, 31], [20, 12, 28])) },
      { name: "Hero", frames: [rect(32, 32, [12, 10, 19, 29], [208, 70, 72]), rect(32, 32, [13, 10, 20, 29], [208, 70, 72]), rect(32, 32, [14, 10, 21, 29], [208, 70, 72])] },
    ],
    tags: [{ name: "idle", from: 1, to: 3 }],
  });
}
const BURN = { name: "burn", frames: 4, fps: 20, steps: [{ type: "outline" }, { type: "dissolve" }] };

test("fx_pipeline preview returns a contact sheet and changes nothing", async () => {
  const fake = sprite();
  const r = await runTool(findTool("fx_pipeline"), { pipeline: BURN }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);
  assert.ok(r.content.some((c) => c.type === "image"));
  assert.match(textOf(r), /Preview of pipeline burn on Hero: 4 frames \(nothing changed\)/);
  const bad = await runTool(findTool("fx_pipeline"), { pipeline: { name: "x", steps: [{ type: "nope" }] } }, fake);
  assert.ok(bad.isError);
  assert.match(textOf(bad), /steps\.0\.type: type must be one of/);
});

test("fx_pipeline apply over a layer: one put_images request, 'AI: fx <name>' over the hidden source, the pipeline stored", async () => {
  const fake = sprite();
  const r = await runTool(findTool("fx_pipeline"), { pipeline: { ...BURN, source: { frame: 2 } }, apply: "layer" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(fake.calls.filter((c) => WRITES.has(c.method)).map((c) => c.method), ["put_images"]);
  const st = await documentOf(fake).info();
  assert.equal(st.durations.length, 7);
  assert.deepEqual(st.durations.slice(2, 6), [50, 50, 50, 50]);
  const hero = st.layers.find((l) => l.name === "Hero"), fx = st.layers.find((l) => l.name === "AI: fx burn");
  assert.ok(fx && hero && !hero.visible && fx.visible);
  assert.equal(fx.fx.id, "pipeline:burn");
  assert.equal(fx.fx.fps, 20);
  assert.deepEqual(parsePipeline(fx.fx.recipe), parsePipeline({ ...BURN, source: { layer: "Hero", frame: 2 } }), "the pipeline round-trips, its source resolved");
  assert.match(textOf(r), /inserted 4 frames of 50 ms after frame 2 \(frames 3-6\)/);
  // Over existing frames: no frames added.
  const fake2 = sprite();
  const o = await runTool(findTool("fx_pipeline"), { pipeline: { name: "edge", frames: { over: "all" }, steps: [{ type: "outline", color: -1 }] }, apply: "layer" }, fake2);
  assert.ok(!o.isError, textOf(o));
  assert.equal((await documentOf(fake2).info()).durations.length, 3);
  assert.match(textOf(o), /ran over frames 1, 2, 3/);
});

test("fx_pipeline on a blank canvas writes a new layer (frames added as needed), its colors appended in the same request", async () => {
  const fake = sprite();
  const r = await runTool(findTool("fx_pipeline"), {
    pipeline: { name: "mist", source: { w: 16, h: 16, x: 4, y: 4, frame: 2 }, frames: 4, loop: true,
      steps: [{ type: "noise_fill", target: "canvas", cutoff: 0.4, ramp: ["#223344", "#88aacc"], noise: { scale: 4 } }] },
    apply: "layer",
  }, fake);
  assert.ok(!r.isError, textOf(r));
  const calls = fake.calls.filter((c) => WRITES.has(c.method));
  assert.deepEqual(calls.map((c) => c.method), ["put_images"]);
  assert.deepEqual(calls[0].params.palette.sort(), ["#223344", "#88aacc"]);
  const st = await documentOf(fake).info();
  assert.equal(st.durations.length, 5, "frames 2-5: two added");
  const mist = st.layers.find((l) => l.name === "AI: fx mist");
  assert.ok(mist && mist.fx.id === "pipeline:mist" && mist.fx.loop);
  assert.ok(st.layers.find((l) => l.name === "Hero").visible, "no source to hide");
});
