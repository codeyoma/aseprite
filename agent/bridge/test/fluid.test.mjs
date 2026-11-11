// Fluid effects (#106): the gas and liquid solvers, shading, seamless loops and the fluid_fx tool on the fake document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLUID_PRESET_NAMES, FlipSim, GasSim, NO_FORCES, WALLS, frameDiff, loopSeam, renderFluid, rng, shade } from "../dist/sprite_fx/fluid.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const WRITES = new Set(["put_image", "put_images", "create_animation", "execute_lua", "set_palette", "write_pixels"]);
const lit = (data) => { let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) n++; return n; };
const hexOf = (d, i) => "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");

function heroSprite(durations = [100]) {
  const body = rect(64, 64, [28, 40, 35, 60], [40, 60, 200]);
  return fakeDocument({ width: 64, height: 64, durations, layers: [{ name: "Hero", frames: durations.map(() => body) }], layer: "Hero" });
}

/** A gas box with a warm blob of smoke and a random swirl. */
function blobGas(seed = 7, amp = 20) {
  const g = new GasSim(32, 32, WALLS);
  const r = rng(seed);
  for (let j = 10; j < 18; j++) for (let i = 12; i < 20; i++) { g.d[j * 32 + i] = 1; g.t[j * 32 + i] = 1; }
  for (let k = 0; k < g.u.length; k++) g.u[k] = (r() - 0.5) * amp;
  for (let k = 0; k < g.v.length; k++) g.v[k] = (r() - 0.5) * amp;
  return g;
}

test("gas: mass is roughly conserved in a closed box without dissipation", () => {
  // Semi-Lagrangian advection is not exactly conservative; a swirling box keeps its smoke within a few percent.
  // (Strong buoyancy slamming smoke into a wall loses more, ~15%: fine for effects, which use open sides.)
  const g = blobGas(7, 8);
  const before = g.mass();
  const k = { ...NO_FORCES, vorticity: 8, iterations: 30 };
  for (let s = 0; s < 80; s++) g.step(1 / 40, k);
  const after = g.mass();
  assert.ok(Math.abs(after - before) / before < 0.1, `mass ${before} -> ${after}`);
  // Dissipation does lose it.
  const h = blobGas(7, 8);
  for (let s = 0; s < 80; s++) h.step(1 / 40, { ...k, dissipation: 1 });
  assert.ok(h.mass() < 0.25 * before);
});

test("gas: the projection removes the divergence", () => {
  const g = blobGas();
  const before = g.divergence();
  g.project(80);
  const after = g.divergence();
  assert.ok(after.mean < before.mean * 0.002, `mean divergence ${before.mean} -> ${after.mean}`);
  assert.ok(after.max < before.max * 0.005, `max divergence ${before.max} -> ${after.max}`);
  // Walls let nothing through.
  for (let j = 0; j < 32; j++) { assert.equal(g.u[j * 33], 0); assert.equal(g.u[j * 33 + 32], 0); }
});

test("liquid: the projection drives the fluid cells toward zero divergence", () => {
  const f = new FlipSim(24, 24, 4000);
  const r = rng(3);
  for (let j = 10; j < 22; j++) for (let i = 2; i < 22; i++) for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    f.add(i + ox, j + oy, (r() - 0.5) * 30, (r() - 0.5) * 30);
  }
  const n = f.n;
  f.step(1 / 120, 300);
  assert.equal(f.n, n, "no particle is lost");
  const after = f.divergence();
  // Measured without the density correction (which adds divergence on purpose where particles bunch up).
  f.project(80, 0);
  assert.ok(f.divergence().mean < 0.05, `mean divergence ${after.mean} -> ${f.divergence().mean}`);
  for (let k = 0; k < f.n; k++) assert.ok(f.px[k] >= 1 && f.px[k] <= 23 && f.py[k] >= 1 && f.py[k] <= 23, "particles stay inside the box");
});

test("every preset renders, deterministically for a seed", () => {
  for (const preset of FLUID_PRESET_NAMES) {
    const a = renderFluid({ preset, seed: 5, frames: 8 });
    assert.equal(a.frames.length, 8, preset);
    assert.ok(a.frames.some((f) => lit(f.data) > 10), `${preset} draws`);
    const b = renderFluid({ preset, seed: 5, frames: 8 });
    assert.ok(a.frames.every((f, i) => frameDiff(f, b.frames[i]) === 0), `${preset} is deterministic`);
  }
  const c = renderFluid({ preset: "smoke", seed: 6, frames: 8 });
  const d = renderFluid({ preset: "smoke", seed: 5, frames: 8 });
  assert.ok(c.frames.some((f, i) => frameDiff(f, d.frames[i]) > 0), "another seed, another variation");
});

test("shading: ramp colors or fully transparent, dithered between steps", () => {
  const ramp = [{ r: 10, g: 0, b: 0, a: 255 }, { r: 100, g: 0, b: 0, a: 255 }, { r: 200, g: 0, b: 0, a: 255 }];
  const W = 16, H = 4, v = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v[y * W + x] = x / (W - 1);
  const img = shade(v, W, H, ramp, 0.1, true);
  const reds = new Set();
  for (let i = 0; i < img.data.length; i += 4) {
    assert.ok(img.data[i + 3] === 0 || img.data[i + 3] === 255, "no partial alpha");
    if (img.data[i + 3]) reds.add(img.data[i]);
  }
  assert.deepEqual([...reds].sort((a, b) => a - b), [10, 100, 200]);
  assert.equal(img.data[3], 0, "below the threshold is transparent");
  assert.equal(img.data[(W - 1) * 4], 200, "full is the brightest");
  // Between two steps both appear (ordered dither), not a hard band.
  const mid = Array.from({ length: 4 }, (_, y) => img.data[(y * W + 8) * 4]).concat(Array.from({ length: 4 }, (_, y) => img.data[(y * W + 9) * 4]));
  assert.ok(new Set(mid).size >= 2, `dithered: ${mid}`);
});

test("loops are seamless: the last frame flows into the first like any other step", () => {
  for (const preset of ["smoke", "torch", "poison-gas", "steam"]) {
    const r = renderFluid({ preset, seed: 2 });
    assert.ok(r.loop, preset);
    const s = loopSeam(r.frames);
    assert.deepEqual(r.seam, s);
    assert.ok(s.last <= 1.6 * s.median + 12, `${preset}: seam ${s.last} px vs median step ${s.median} px`);
  }
});

test("one-shot gases end empty; a 64x64 x 48-frame render stays well under 2 s", () => {
  for (const preset of ["smoke-puff", "fire-burst"]) {
    const r = renderFluid({ preset, seed: 1 });
    assert.equal(lit(r.frames.at(-1).data), 0, `${preset} ends empty`);
  }
  const t = performance.now();
  renderFluid({ preset: "smoke", width: 64, height: 64, frames: 48, loop: false });
  const ms = performance.now() - t;
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test("fluid_fx preview returns a contact sheet and changes nothing", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("fluid_fx"), { preset: "torch", frames: 6 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.ok(r.content.some((c) => c.type === "image"));
  assert.match(textOf(r), /Preview of torch: 6 frames .*Nothing changed/);
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 0);
  assert.deepEqual(fake.layerNames(), ["Hero"]);
});

test("fluid_fx layer: one put_images request, palette colors only, the FX record", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("fluid_fx"), { preset: "smoke", apply: "layer", x: 32, y: 60, frames: 12, seed: 4 }, fake);
  assert.ok(!r.isError, textOf(r));
  const writes = fake.calls.filter((c) => WRITES.has(c.method));
  assert.deepEqual(writes.map((c) => c.method), ["put_images"], "one write: one undo step");
  const put = writes[0].params;
  assert.deepEqual(fake.layerNames(), ["Hero", "AI: fx fluid smoke"]);
  const st = (await fake.request("get_state")).result.activeSprite;
  assert.equal(st.frames.length, 12, "frames added past the end");
  const pal = new Set((await fake.request("get_palette")).result.colors.map((c) => c.slice(0, 7)));
  for (const c of put.palette) assert.ok(pal.has(c));
  let n = 0;
  for (const im of fake.images("AI: fx fluid smoke")) {
    if (!im) continue;
    for (let i = 0; i < im.length; i += 4) {
      if (!im[i + 3]) continue;
      assert.equal(im[i + 3], 255, "no partial alpha");
      assert.ok(pal.has(hexOf(im, i)), `${hexOf(im, i)} is in the palette`);
      n++;
    }
  }
  assert.ok(n > 100, "it drew smoke");
  const layer = st.layers.find((l) => l.name === "AI: fx fluid smoke");
  assert.equal(layer.fx.id, "fluid:smoke");
  assert.deepEqual([layer.fx.x, layer.fx.y, layer.fx.fps, layer.fx.loop], [32, 60, 12, true]);
  const render = JSON.parse(layer.fx.render);
  assert.equal(render.preset, "smoke");
  assert.equal(render.seed, 4);
  // check_fx reads it like any effect layer.
  const chk = await runTool(findTool("check_fx"), {}, fake);
  assert.ok(!chk.isError, textOf(chk));
});

test("fluid_fx: emit_layer makes a layer's pixels the source; sprite makes its own sprite", async () => {
  const fake = heroSprite();
  const r = await runTool(findTool("fluid_fx"), { preset: "smoke-puff", apply: "layer", emit_layer: "Hero", frames: 8 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /emitting from Hero/);
  assert.equal(fake.calls.filter((c) => WRITES.has(c.method)).length, 1);
  const bad = await runTool(findTool("fluid_fx"), { preset: "smoke", emit_layer: "Nope" }, fake);
  assert.equal(bad.isError, true);

  const fresh = heroSprite();
  const s = await runTool(findTool("fluid_fx"), { preset: "splash", apply: "sprite", frames: 10, colors: ["#002244", "#0055aa", "#55aaff", "#ffffff"] }, fresh);
  assert.ok(!s.isError, textOf(s));
  const st = (await fresh.request("get_state")).result.activeSprite;
  assert.deepEqual([st.width, st.height, st.frames.length], [48, 32, 10]);
  assert.deepEqual(st.tags.map((t) => t.name), ["fluid-splash"]);
  assert.equal(st.layers[0].fx.id, "fluid:splash");
  const pal = (await fresh.request("get_palette")).result.colors;
  assert.ok(pal.every((c) => ["#002244", "#0055aa", "#55aaff", "#ffffff"].includes(c)), pal.join(" "));
});
