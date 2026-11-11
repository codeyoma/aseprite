// Concept-first (#79): a synthetic storyboard read into a pixel spec (panels, silhouette bounds in target
// pixels, color roles), its panels put on a locked reference layer in one write, the stored spec, and the
// mismatch regions ordered largest first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { fitPanel, mismatchRegions, readConcept, readStoryboard } from "../dist/concept.js";
import { findTool, runTool } from "../dist/tools.js";
import { documentOf } from "../dist/document.js";
import { ImageJobs, codexInstruction, inside } from "../dist/image_gen.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const run = (name, input, fake) => runTool(findTool(name), input, fake);
const OUTLINE = [24, 20, 37], BODY = [200, 40, 60], SKIN = [250, 210, 170];

/**
 * A 4-panel storyboard, 256x64 on white: in panel i a 12x24 figure (outline, red body, a skin-colored head) stands
 * with its feet on y 55, 10 px further right each panel (x 10 + 10i). At 32x32 that is x 5 + 5i, y 16-27.
 */
function storyboard() {
  const W = 256, H = 64, d = new Uint8Array(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([255, 255, 255, 255], i);
  const fill = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([...c, 255], (y * W + x) * 4); };
  for (let p = 0; p < 4; p++) {
    const x = p * 64 + 10 + 10 * p;
    fill(x, 32, x + 11, 55, OUTLINE);
    fill(x + 2, 42, x + 9, 53, BODY);
    fill(x + 2, 34, x + 9, 40, SKIN);
  }
  return { width: W, height: H, data: d };
}

function writePng(img) {
  const path = join(mkdtempSync(join(tmpdir(), "concept-")), "storyboard.png");
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

test("readStoryboard finds the 4 panels by counting figures, and cuts a given grid evenly", () => {
  const auto = readStoryboard(storyboard());
  assert.deepEqual([auto.cols, auto.rows], [4, 1]);
  assert.deepEqual(auto.panels.map((r) => [r.x, r.w]), [[0, 64], [64, 64], [128, 64], [192, 64]]);
  assert.match(auto.background, /ffffff/);
  const grid = readStoryboard(storyboard(), { cols: 2, rows: 1 });
  assert.deepEqual(grid.panels.map((r) => [r.x, r.y, r.w, r.h]), [[0, 0, 128, 64], [128, 0, 128, 64]]);
});

test("readConcept: silhouette bounds per panel in target pixels, and color roles", () => {
  for (const method of ["snap", "nearest"]) {
    const r = readConcept(storyboard(), 32, 32, "auto", method);
    assert.equal(r.frames.length, 4);
    r.frames.forEach((f, i) => {
      assert.deepEqual(f.bounds, [5 + 5 * i, 16, 10 + 5 * i, 27], `${method} panel ${i + 1}`);
      assert.deepEqual(f.center, [7.5 + 5 * i, 21.5]);
      assert.equal(f.feet[1], 27);
    });
  }
  const roles = Object.fromEntries(readConcept(storyboard(), 32, 32).roles.map((c) => [c.role, c.hex]));
  assert.equal(roles.outline, "#181425");
  assert.ok(roles.main, "a main color");
});

test("fitPanel keeps the aspect ratio, centered across and standing on the bottom edge", () => {
  const panel = { width: 8, height: 4, data: rect(8, 4, [0, 0, 7, 3], [255, 0, 0]) };
  const out = fitPanel(panel, 8, 8, "nearest");
  const rows = [];
  for (let y = 0; y < 8; y++) rows.push(out.data[(y * 8) * 4 + 3] ? "x" : ".");
  assert.equal(rows.join(""), "....xxxx");
});

test("concept_spec returns a JSON skeleton with measured frames and empty landmarks to fill in", async () => {
  const path = writePng(storyboard());
  const fake = fakeDocument({ width: 32, height: 32, layers: [{ name: "Art", frames: [undefined] }] });
  const r = await run("concept_spec", { image: path, target_size: [32, 32], panels: { cols: 4, rows: 1 } }, fake);
  assert.equal(r.isError, undefined, textOf(r));
  const spec = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(textOf(r))[1]);
  assert.deepEqual(spec.canvas, [32, 32]);
  assert.deepEqual(spec.source.grid, [4, 1]);
  assert.deepEqual(spec.frames.map((f) => f.bounds), [0, 1, 2, 3].map((i) => [5 + 5 * i, 16, 10 + 5 * i, 27]));
  assert.equal(spec.frames[0].landmarks.eyes, null);
  assert.deepEqual(spec.deviations, []);
  assert.equal(fake.calls.filter((c) => c.method !== "get_state").length, 0, "reads only");
});

test("storyboard_to_frames puts each panel on a frame of a locked, hidden reference layer in one write", async () => {
  const path = writePng(storyboard());
  const fake = fakeDocument({ width: 32, height: 32, layers: [{ name: "Art", frames: [undefined] }] });
  const r = await run("storyboard_to_frames", { image: path, panels: "auto" }, fake);
  assert.equal(r.isError, undefined, textOf(r));
  const writes = fake.calls.filter((c) => !["get_state", "snapshot"].includes(c.method));
  assert.deepEqual(writes.map((c) => c.method), ["put_images"], "one write, one undo step");
  const st = (await fake.request("get_state")).result;
  const ref = st.activeSprite.layers.find((l) => l.name === "AI: Reference");
  assert.equal(st.activeSprite.frames.length, 4);
  assert.deepEqual([ref.visible, ref.editable, ref.celFrames], [false, false, [1, 2, 3, 4]]);
  assert.equal(st.activeLayer, "Art", "the art layer stays active");
  const spec = JSON.parse(st.activeSprite.pixelSpec);
  assert.equal(spec.frames.length, 4, "the measured skeleton is stored when no spec was");
  assert.match(textOf(r), /frame 4: bounds 20,16-25,27/);

  const again = await run("storyboard_to_frames", { image: path }, fake);
  assert.match(textOf(again), /already has a layer 'AI: Reference'/);
  const wrong = await run("storyboard_to_frames", { image: path, name: "Ref 2", target_size: [16, 16] }, fake);
  assert.match(textOf(wrong), /The sprite is 32x32/);
});

test("pixel_spec stores, reads and removes the spec", async () => {
  const fake = fakeDocument({ width: 8, height: 8, layers: [{ name: "Art", frames: [undefined] }] });
  assert.match(textOf(await run("pixel_spec", {}, fake)), /No pixel spec/);
  const stored = await run("pixel_spec", { spec: { canvas: [8, 8], deviations: ["no belt"] } }, fake);
  assert.equal(stored.isError, undefined, textOf(stored));
  assert.match(textOf(await run("pixel_spec", {}, fake)), /"deviations":\["no belt"\]/);
  assert.equal((await run("pixel_spec", { spec: "[1, 2]" }, fake)).isError, true);
  assert.equal((await run("pixel_spec", { spec: "{oops" }, fake)).isError, true);
  await run("pixel_spec", { spec: "" }, fake);
  assert.match(textOf(await run("pixel_spec", {}, fake)), /No pixel spec/);
});

test("mismatchRegions: missing and extra areas, largest first", () => {
  const ref = rect(16, 8, [0, 0, 5, 5], [255, 255, 255]);
  // The art covers the reference's left 2 columns only (24 px missing), plus a 2x2 extra blob far right.
  const art = rect(16, 8, [0, 0, 1, 5], [255, 255, 255]);
  for (const [x, y] of [[12, 1], [13, 1], [12, 2], [13, 2]]) art.set([255, 255, 255, 255], (y * 16 + x) * 4);
  const m = mismatchRegions({ width: 16, height: 8, data: ref }, { width: 16, height: 8, data: art }, 3);
  assert.deepEqual(m.map((x) => [x.kind, x.pixels, x.bounds, x.frame]), [["missing", 24, [2, 0, 5, 5], 3], ["extra", 4, [12, 1, 13, 2], 3]]);
});

test("mismatch_regions lists the largest regions across frames and the centre offsets", async () => {
  const W = 16, H = 8;
  const refFrames = [rect(W, H, [2, 2, 5, 5], [255, 0, 0]), rect(W, H, [8, 2, 11, 5], [255, 0, 0])];
  // Frame 1 matches; frame 2 is drawn 3 px to the left.
  const artFrames = [rect(W, H, [2, 2, 5, 5], [0, 0, 255]), rect(W, H, [5, 2, 8, 5], [0, 0, 255])];
  const fake = fakeDocument({
    width: W, height: H, frames: 2,
    layers: [{ name: "Art", frames: artFrames }, { name: "AI: Reference", visible: false, frames: refFrames }],
  });
  const r = await run("mismatch_regions", { top: 2 }, fake);
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.match(t, /frame 1: overlap 100%/);
  assert.match(t, /frame 2: overlap 14%, art center 6.5,3.5 vs reference 9.5,3.5 \(dx -3, dy 0\)/);
  assert.match(t, /1\. frame 2, (missing|extra) 12 px/);
  assert.match(t, /2\. frame 2, (missing|extra) 12 px/);
  assert.doesNotMatch(t, /3\. /);
});

test("storyboard_to_frames with draft adds an editable pixel draft of few colors in the same write (#102)", async () => {
  const path = writePng(storyboard());
  const fake = fakeDocument({ width: 32, height: 32, layers: [{ name: "Art", frames: [undefined] }] });
  const r = await run("storyboard_to_frames", { image: path, draft: 2 }, fake);
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(fake.calls.filter((c) => !["get_state", "snapshot"].includes(c.method)).map((c) => c.method), ["put_images"]);
  const st = (await fake.request("get_state")).result;
  const draft = st.activeSprite.layers.find((l) => l.name === "AI: Draft");
  assert.deepEqual([draft.visible, draft.editable, draft.celFrames], [true, true, [1, 2, 3, 4]]);
  const colors = new Set();
  for (const f of [1, 2, 3, 4]) {
    const { data } = await documentOf(fake).pixels("AI: Draft", f);
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]) colors.add(data.slice(i, i + 4).join(","));
  }
  assert.ok(colors.size >= 1 && colors.size <= 2, `${colors.size} colors`);
  assert.match(textOf(r), /2-color pixel draft on 'AI: Draft'/);
});

/** A fake image generator and consent for generate_image (#102). */
function imageCtx(fake, { answer = true, delayMs = 0, fail } = {}) {
  const asked = [];
  const out = writePng(storyboard());
  const generator = {
    calls: 0,
    async generate(prompt, aspect, signal) {
      this.calls++;
      await new Promise((r, j) => { const t = setTimeout(r, delayMs); signal.addEventListener("abort", () => { clearTimeout(t); j(new Error("cancelled")); }); });
      if (fail) throw new Error(fail);
      return { path: out, width: 256, height: 64 };
    },
  };
  const images = new ImageJobs(generator);
  return { ctx: { ...fake, ask: async (kind, title) => { asked.push({ kind, title }); return answer; }, images }, asked, generator };
}

test("generate_image asks the user first, then returns the image and the next step (#102)", async () => {
  const { ctx, asked, generator } = imageCtx(fakeDocument({ width: 8, height: 8 }));
  const r = await runTool(findTool("generate_image"), { prompt: "a knight, side view", aspect: "landscape" }, ctx);
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "image_generator");
  assert.match(asked[0].title, /Codex plan's limits.*a knight, side view/);
  assert.equal(generator.calls, 1);
  assert.match(textOf(r), /storyboard_to_frames/);
  assert.ok(r.content.some((c) => c.type === "image"), "a preview");
});

test("generate_image: a declined request generates nothing; outside the panel it is unavailable (#102)", async () => {
  const fake = fakeDocument({ width: 8, height: 8 });
  const { ctx, generator } = imageCtx(fake, { answer: false });
  const r = await runTool(findTool("generate_image"), { prompt: "a knight" }, ctx);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /declined/);
  assert.equal(generator.calls, 0);
  const cli = await runTool(findTool("generate_image"), { prompt: "a knight" }, fake);
  assert.match(textOf(cli), /only in the chat panel/);
});

test("generate_image: a slow job hands back its id, a later call waits for it, and failures say to draw by hand (#102)", async (t) => {
  const { IMAGE_WAIT_MS } = await import("../dist/concept_tools.js");
  assert.ok(IMAGE_WAIT_MS < 60_000, "under a client's tool timeout");
  const jobs = new ImageJobs({ generate: (p, a, signal) => new Promise((r, j) => signal.addEventListener("abort", () => j(new Error("cancelled")))) });
  const job = jobs.start("x", "square");
  assert.equal(await jobs.wait(job, 10), false);
  assert.throws(() => jobs.start("y", "square"), /already being generated/);
  assert.equal(jobs.cancel(job.id), true);
  await job.done;
  assert.match(job.error, /cancelled/);
  const { ctx } = imageCtx(fakeDocument({ width: 8, height: 8 }), { fail: "no image tool" });
  const r = await runTool(findTool("generate_image"), { prompt: "a knight" }, ctx);
  assert.match(textOf(r), /failed: no image tool Draw it yourself/);
  const unknown = await runTool(findTool("generate_image"), { job: "img-99" }, ctx);
  assert.match(textOf(unknown), /No image job/);
});

test("the Codex image instruction asks for one image, no other tools, and the path as JSON (#102)", () => {
  const s = codexInstruction("a red slime", "portrait");
  assert.match(s, /exactly one image, at 1024x1536/);
  assert.match(s, /Don't run shell commands/);
  assert.match(s, /Image: a red slime/);
  const dir = mkdtempSync(join(tmpdir(), "gen-"));
  writeFileSync(join(dir, "a.png"), "x");
  assert.equal(inside(dir, join(dir, "a.png")), true);
  assert.equal(inside(dir, join(tmpdir())), false);
});

// Layered characters (#103) -------------------------------------------------------------------------------------

/** A 200x200 sheet on white, a 2x2 grid of 100 px panels: per pose, a blue torso and (optionally) a red arm. */
function sheet({ torso = true, arm = true, armShift = 0 } = {}) {
  const W = 200, data = new Uint8Array(W * W * 4).fill(255);
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data.set([...c, 255], (y * W + x) * 4); };
  for (const [px, armX] of [[0, 60], [100, 25]]) {           // pose 1 arm right of the torso, pose 2 left
    if (torso) rect(px + 35, 30, px + 64, 95, [40, 90, 220]);
    if (arm) rect(px + armX + armShift, 40, px + armX + armShift + 9, 70, [220, 40, 40]);
  }
  return writePng({ width: W, height: W, data });
}

test("layered: grids, prompts, and the master-then-layers pool (3 at a time, one retry) (#103)", async () => {
  const { gridFor, masterPrompt, layerPrompt, generateLayered, DEFAULT_LAYERS } = await import("../dist/layered.js");
  assert.deepEqual([1, 2, 4, 6, 9].map((n) => { const g = gridFor(n); return `${g.cols}x${g.rows} ${g.aspect}`; }),
    ["1x1 square", "2x2 square", "2x2 square", "3x2 landscape", "3x3 square"]);
  assert.throws(() => gridFor(10), /1 to 9 poses/);
  const req = { subject: "a knight with a red plume", view: "Side view, facing right", poses: ["contact", "passing"] };
  const mp = masterPrompt(req, gridFor(2));
  assert.match(mp, /exactly 4 equal square panels in a 2 x 2 grid/);
  assert.match(mp, /Only the first 2 panels/);
  assert.match(mp, /1\. contact\n2\. passing/);
  assert.match(layerPrompt(DEFAULT_LAYERS[7], gridFor(2), 2), /ONLY the near arm .* same position, size, angle and colors/);
  assert.deepEqual(DEFAULT_LAYERS.map((l) => l.name), ["far arm", "far leg", "torso", "near leg", "head", "eyes", "hair", "near arm"]);

  let live = 0, peak = 0;
  const calls = [];
  const failOnce = new Set(["eyes"]);
  const gen = {
    async generate(prompt, aspect, signal, refs = []) {
      calls.push({ prompt, refs });
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      const part = DEFAULT_LAYERS.find((l) => prompt.includes(l.part));
      if (part && failOnce.delete(part.name)) throw new Error("flaky");
      return { path: part ? `/x/${part.name}.png` : "/x/master.png", width: 1024, height: 1024 };
    },
  };
  const progress = [];
  const r = await generateLayered(gen, req, DEFAULT_LAYERS, new AbortController().signal, 3, (d, t) => progress.push(`${d}/${t}`));
  assert.equal(r.master.path, "/x/master.png");
  assert.equal(calls[0].refs.length, 0, "the master has no reference");
  assert.ok(calls.slice(1).every((c) => c.refs[0] === "/x/master.png"), "every layer is drawn from the master");
  assert.ok(peak <= 3, `at most 3 at a time (peak ${peak})`);
  assert.equal(calls.length, 1 + 8 + 1, "one retry for the flaky layer");
  assert.ok(r.layers.every((l) => l.image && !l.error), JSON.stringify(r.layers));
  assert.equal(progress.at(-1), "9/9");
});

test("alignToMaster: finds the shift that puts a part inside the master's silhouette (#103)", async () => {
  const { alignToMaster, shifted } = await import("../dist/layered.js");
  const img = (w, h, pts) => { const d = new Uint8Array(w * h * 4); for (const [x, y] of pts) d.set([255, 0, 0, 255], (y * w + x) * 4); return { width: w, height: h, data: d }; };
  const box = (x0, y0, x1, y1) => { const p = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p.push([x, y]); return p; };
  const master = img(20, 20, box(5, 5, 14, 14));
  const part = img(20, 20, box(8, 4, 10, 6));                 // sticks out above by 1 row
  const a = alignToMaster(part, master);
  assert.deepEqual([a.dx, a.dy, a.outside], [0, 1, 0]);
  const far = alignToMaster(img(20, 20, box(0, 0, 2, 2)), master, 1);
  assert.ok(far.outside > 0.35, "too far to fix: reported as misaligned");
  assert.equal(shifted(part, 0, 1).data[(5 * 20 + 8) * 4 + 3], 255);
});

test("generate_character: one consent, then the parts land in a group, aligned, on the key frames (#103)", async () => {
  const { ImageJobs } = await import("../dist/image_gen.js");
  const paths = { master: sheet(), torso: sheet({ arm: false }), "near arm": sheet({ torso: false, armShift: 5 }) };
  const gen = { async generate(prompt) {
    const name = prompt.includes("ONLY the torso") ? "torso" : prompt.includes("ONLY the arm") ? "near arm" : "master";
    return { path: paths[name], width: 200, height: 200 };
  } };
  const lua = [];
  const fake = fakeDocument({ width: 20, height: 20, frames: 6, tags: [{ name: "walk", from: 1, to: 6 }], layers: [{ name: "Art", frames: [] }],
    extra: { execute_lua: (p) => { lua.push(p.code); return { ok: true }; } } });
  const asked = [];
  const ctx = { ...fake, images: new ImageJobs(gen), ask: async (k, t) => { asked.push(t); return true; } };
  const r = await runTool(findTool("generate_character"), {
    subject: "a knight", poses: ["contact", "passing"], frames: [1, 3], tag: "walk", name: "Knight",
    layers: [{ name: "torso", part: "the torso" }, { name: "near arm", part: "the arm" }],
  }, ctx);
  const t = textOf(r);
  assert.equal(r.isError, undefined, t);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /3 images \(1 master sheet \+ 2 layers: torso, near arm/);
  assert.match(t, /2 part layers in the group "AI: Knight" \(bottom to top: torso, near arm\) on frames 1, 3/);
  assert.match(t, /- near arm: pose 1 moved -1,0\n/, "pose 1 sticks out past the master and is moved back; pose 2 already lies inside");
  assert.match(t, /Motion stage "keys" for "walk" \(keys 1, 3\)/);
  const st = (await fake.request("get_state")).result.activeSprite;
  const names = st.layers.map((l) => l.name);
  assert.ok(names.includes("AI: Reference") && names.includes("AI: torso") && names.includes("AI: near arm"), names.join(", "));
  const ref = st.layers.find((l) => l.name === "AI: Reference");
  assert.deepEqual([ref.visible, ref.editable], [false, false]);
  const spec = JSON.parse(st.pixelSpec);
  assert.deepEqual(spec.motion, { tag: "walk", keys: [1, 3], stage: "keys", walk: true });
  assert.match(lua[0], /g.name = "AI: Knight"/);
  const again = await runTool(findTool("generate_character"), { job: "img-1" }, ctx);
  assert.match(textOf(again), /already on the sprite/);
});
