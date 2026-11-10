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
