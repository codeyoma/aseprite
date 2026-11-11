// Review views for snapshot (#75): filmstrip, onion and compare on the fake document; the layouts, the frame
// numbers, the ghost tints and the compare cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { findTool, runTool } from "../dist/tools.js";
import { sheetGeometry } from "../dist/image.js";
import { filmstripLayout, onionNeighbors, VIEW_MAX, VIEW_TARGET } from "../dist/views.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const pngOf = (r) => {
  const img = r.content.find((c) => c.type === "image");
  assert.ok(img, `an image in ${textOf(r)}`);
  return PNG.sync.read(Buffer.from(img.data, "base64"));
};
const px = (png, x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
const snapshot = (fake, input) => runTool(findTool("snapshot"), input, fake);
const LABEL = [240, 240, 240, 255], BACKDROP = [32, 32, 40, 255];

/** A 16x16 sprite of 4 frames: a white 2x2 dot that moves 4 px right each frame; tag bounce = 2-4. */
function dots() {
  const frames = [0, 1, 2, 3].map((i) => rect(16, 16, [1 + 4 * i, 7, 2 + 4 * i, 8], [255, 255, 255]));
  return fakeDocument({ width: 16, height: 16, frames: 4, layers: [{ name: "Art", frames }], tags: [{ name: "bounce", from: 2, to: 4 }] });
}

test("filmstripLayout: the largest zoom that fits, balanced rows, capped size", () => {
  // 16 px frames: zoom 16 (256 px cells); 3 fit in 1024 px, so 4 frames wrap into 2 rows of 2.
  assert.deepEqual(filmstripLayout(4, 16, 16), { zoom: 16, columns: 2, shown: 4, width: 524, height: 550 });
  assert.deepEqual(filmstripLayout(3, 16, 16), { zoom: 16, columns: 3, shown: 3, width: 784, height: 277 });
  // Big frames shrink until the sheet fits; every layout stays within the target.
  for (const [n, w, h] of [[8, 64, 64], [12, 32, 48], [24, 128, 96], [6, 300, 200]]) {
    const l = filmstripLayout(n, w, h);
    assert.ok(l.width <= VIEW_TARGET && l.height <= VIEW_TARGET, JSON.stringify({ n, w, h, l }));
    assert.equal(l.shown, n);
    const g = sheetGeometry(n, w, h, { columns: l.columns, zoom: l.zoom });
    assert.deepEqual([g.width, g.height], [l.width, l.height]);
  }
  // An explicit scale is kept while it fits VIEW_MAX, and lowered when it does not.
  assert.equal(filmstripLayout(4, 16, 16, 4).zoom, 4);
  const big = filmstripLayout(4, 256, 256, 32);
  assert.ok(big.zoom < 32 && big.width <= VIEW_MAX && big.height <= VIEW_MAX, JSON.stringify(big));
  // Too many large frames even at zoom 1: only the first ones are shown.
  const many = filmstripLayout(200, 400, 400);
  assert.ok(many.shown < 200 && many.width <= VIEW_MAX && many.height <= VIEW_MAX, JSON.stringify(many));
});

test("filmstrip of a tag: one image, frame numbers above each cell, frames in order", async () => {
  const fake = dots();
  const res = await snapshot(fake, { view: "filmstrip", tag: "bounce" });
  assert.equal(res.isError, undefined, textOf(res));
  const png = pngOf(res);
  assert.deepEqual([png.width, png.height], [784, 277]);
  const g = sheetGeometry(3, 16, 16, { columns: 3, zoom: 16 });
  // "2" over the first cell: its top row is lit across, its second row only at the right column.
  const c0 = g.cell(0), c1 = g.cell(1);
  assert.deepEqual(px(png, c0.x, c0.y), LABEL);
  assert.deepEqual(px(png, c0.x + 4, c0.y + 2), LABEL);
  assert.deepEqual(px(png, c0.x, c0.y + 2), BACKDROP);
  // "3" over the second cell; "4" over the third (top row 5: left and right lit, middle not).
  assert.deepEqual(px(png, c1.x + 2, c1.y), LABEL);
  const c2 = g.cell(2);
  assert.deepEqual(px(png, c2.x, c2.y), LABEL);
  assert.deepEqual(px(png, c2.x + 2, c2.y), BACKDROP);
  // Frame 2's dot is at x 5-6 in the first cell; frame 3's at x 9-10 in the second.
  const dot = (cell, x) => px(png, cell.x + x * 16 + 8, cell.y + g.labelH + 7 * 16 + 8);
  assert.deepEqual(dot(c0, 5), [255, 255, 255, 255]);
  assert.notDeepEqual(dot(c0, 9), [255, 255, 255, 255]);
  assert.deepEqual(dot(c1, 9), [255, 255, 255, 255]);
  // The gap between cells is the backdrop; transparent pixels show the checker.
  assert.deepEqual(px(png, c1.x - 2, c1.y + 100), BACKDROP);
  assert.ok([204, 153].includes(px(png, c0.x + 1, c0.y + g.labelH + 1)[0]));
  assert.match(textOf(res), /Filmstrip of frames 2-4 \(tag "bounce"\): 3 frames of 16x16 px at 16x, 3 per row, 100 ms each \(784x277\)/);
  // Only snapshots went over the wire.
  assert.ok(fake.calls.every((c) => ["get_state", "snapshot"].includes(c.method)), fake.calls.map((c) => c.method).join());
});

test("filmstrip: a frames range, every frame by default, and an unknown tag", async () => {
  const fake = dots();
  assert.match(textOf(await snapshot(fake, { view: "filmstrip", frames: "1-2" })), /frames 1-2: 2 frames/);
  const all = await snapshot(fake, { view: "filmstrip" });
  assert.match(textOf(all), /frames 1-4: 4 frames of 16x16 px at 16x, 2 per row/);
  assert.deepEqual([pngOf(all).width, pngOf(all).height], [524, 550]);
  const bad = await snapshot(fake, { view: "filmstrip", tag: "walk" });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /No tag named "walk" \(tags: bounce\)/);
});

test("onion: neighbors ghosted under the frame, earlier red, later blue", async () => {
  const fake = dots();
  const res = await snapshot(fake, { view: "onion", frame: 2, scale: 1, background: "transparent" });
  const png = pngOf(res);
  assert.deepEqual([png.width, png.height], [16, 16]);
  // The target (frame 2, x 5) is solid white; frame 1 (x 1) a low-alpha red ghost; frame 3 (x 9) blue.
  assert.deepEqual(px(png, 5, 7), [255, 255, 255, 255]);
  const before = px(png, 1, 7), after = px(png, 9, 7);
  assert.deepEqual(before, [255, 131, 131, 96]);
  assert.deepEqual(after, [131, 160, 255, 96]);
  assert.deepEqual(px(png, 13, 7), [0, 0, 0, 0], "frame 4 is not a neighbor with ghosts 1");
  assert.match(textOf(res), /Onion skin of frame 2: .*earlier frames \(1\) are ghosted in red and later frames \(3\) in blue/);
  // Two ghosts each side: the farther one is fainter.
  const two = pngOf(await snapshot(fake, { view: "onion", frame: 2, ghosts: 2, scale: 1, background: "transparent" }));
  assert.equal(px(two, 13, 7)[3], 64);
  assert.deepEqual(px(two, 1, 7), [255, 131, 131, 96]);
  // Over the default checker the ghost tints the background and the image is upscaled.
  const shown = pngOf(await snapshot(fake, { view: "onion", frame: 2 }));
  assert.deepEqual([shown.width, shown.height], [512, 512]);
  const g = px(shown, 1 * 32 + 16, 7 * 32 + 16);
  assert.ok(g[0] > g[2] && g[3] === 255, `red-ish over the checker: ${g}`);
});

test("onion in a tag wraps around it; neighbors stop at the ends otherwise", async () => {
  assert.deepEqual(onionNeighbors(2, 1, 2, 4, true), [{ frame: 4, distance: 1, before: true }, { frame: 3, distance: 1, before: false }]);
  assert.deepEqual(onionNeighbors(1, 2, 1, 4, false), [{ frame: 2, distance: 1, before: false }, { frame: 3, distance: 2, before: false }]);
  const fake = dots();
  const res = await snapshot(fake, { view: "onion", tag: "bounce", scale: 1, background: "transparent" });
  const png = pngOf(res);
  assert.deepEqual(px(png, 5, 7), [255, 255, 255, 255], "defaults to the tag's first frame");
  assert.deepEqual(px(png, 13, 7), [255, 131, 131, 96], "frame 4 comes before frame 2 in the loop");
  assert.deepEqual(px(png, 9, 7), [131, 160, 255, 96]);
  assert.match(textOf(res), /wrapping around the tag/);
  assert.equal((await snapshot(fake, { view: "onion", tag: "bounce", frame: 1 })).isError, true);
});

test("compare: the reference layer left, the art without it right, labelled", async () => {
  const ref = rect(16, 16, [0, 0, 3, 3], [200, 40, 40]), art = rect(16, 16, [8, 8, 11, 11], [40, 200, 40]);
  const fake = fakeDocument({ width: 16, height: 16, layers: [{ name: "Art", frames: [art] }, { name: "Reference", frames: [ref] }] });
  const res = await snapshot(fake, { view: "compare" });
  assert.equal(res.isError, undefined, textOf(res));
  const png = pngOf(res);
  assert.deepEqual([png.width, png.height], [524, 277]);
  const g = sheetGeometry(2, 16, 16, { columns: 2, zoom: 16 });
  const at = (n, x, y) => px(png, g.cell(n).x + x * 16 + 8, g.cell(n).y + g.labelH + y * 16 + 8);
  assert.deepEqual(at(0, 1, 1), [200, 40, 40, 255], "REF shows the reference");
  assert.notDeepEqual(at(0, 9, 9), [40, 200, 40, 255], "REF shows only the reference");
  assert.deepEqual(at(1, 9, 9), [40, 200, 40, 255], "ART shows the art");
  assert.notDeepEqual(at(1, 1, 1), [200, 40, 40, 255], "ART leaves the reference out");
  // "REF": R's top row is lit in its left two columns; "ART": A's top row only in the middle.
  assert.deepEqual(px(png, g.cell(0).x, g.cell(0).y), LABEL);
  assert.deepEqual(px(png, g.cell(0).x + 4, g.cell(0).y), BACKDROP);
  assert.deepEqual(px(png, g.cell(1).x + 2, g.cell(1).y), LABEL);
  assert.deepEqual(px(png, g.cell(1).x, g.cell(1).y), BACKDROP);
  assert.match(textOf(res), /left REF is layer "Reference", right ART is the sprite without it/);
  // An explicit reference and art layer; errors name what is missing.
  assert.match(textOf(await snapshot(fake, { view: "compare", reference: "Reference", layer: "Art" })), /right ART is layer "Art"/);
  assert.match(textOf(await snapshot(fake, { view: "compare", reference: "Sketch" })), /No layer named "Sketch"/);
  const none = fakeDocument({ width: 16, height: 16, layers: [{ name: "Art", frames: [art] }] });
  assert.match(textOf(await snapshot(none, { view: "compare" })), /No reference layer found/);
});

test("compare with a hidden reference shows the sprite as it is", async () => {
  const ref = rect(16, 16, [0, 0, 3, 3], [200, 40, 40]), art = rect(16, 16, [8, 8, 11, 11], [40, 200, 40]);
  const fake = fakeDocument({ width: 16, height: 16, layers: [{ name: "Art", frames: [art] }, { name: "ref", visible: false, frames: [ref] }] });
  const png = pngOf(await snapshot(fake, { view: "compare" }));
  const g = sheetGeometry(2, 16, 16, { columns: 2, zoom: 16 });
  assert.deepEqual(px(png, g.cell(0).x + 24, g.cell(0).y + g.labelH + 24), [200, 40, 40, 255]);
  assert.deepEqual(px(png, g.cell(1).x + 9 * 16 + 8, g.cell(1).y + g.labelH + 9 * 16 + 8), [40, 200, 40, 255]);
});

test("snapshot without a view is unchanged; the step label names the view", async () => {
  const fake = dots();
  const res = await snapshot(fake, { frame: 3 });
  assert.equal(textOf(res), "16x16 px, frame 3, shown at 32x");
  assert.deepEqual([pngOf(res).width, pngOf(res).height], [512, 512]);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.params]), [["snapshot", { frame: 3, layer: undefined }]]);
  const label = findTool("snapshot").label;
  assert.equal(label({}), "Look at the sprite");
  assert.equal(label({ view: "filmstrip" }), "Look at the filmstrip");
  assert.equal(label({ view: "onion" }), "Look at the onion skin");
  assert.equal(label({ view: "compare" }), "Compare with the reference");
});

test("contactSheet notes: a frame's ms right-aligned in the label strip, only when it fits", async () => {
  const { contactSheet, sheetGeometry } = await import("../dist/image.js");
  const frame = { width: 32, height: 8, data: new Uint8Array(32 * 8 * 4) };
  const bg = { r: 0, g: 0, b: 0, a: 255 }, labelColor = { r: 255, g: 255, b: 255, a: 255 };
  const lit = (img, x0, x1, y1) => { let n = 0; for (let y = 0; y < y1; y++) for (let x = x0; x < x1; x++) if (img.data[(y * img.width + x) * 4]) n++; return n; };
  const o = { columns: 1, zoom: 2, background: bg, labelColor };
  const g = sheetGeometry(1, 32, 8, o);
  const right = (img) => lit(img, g.gap + g.cellW - 20, g.gap + g.cellW, g.gap + 10);
  assert.equal(right(contactSheet([frame], { ...o, labels: ["5"] })), 0);
  assert.ok(right(contactSheet([frame], { ...o, labels: ["5"], notes: ["180MS"] })) > 0, "the note is drawn at the right");
  const narrow = { width: 4, height: 8, data: new Uint8Array(4 * 8 * 4) };
  const a = contactSheet([narrow], { ...o, labels: ["5"] }), b = contactSheet([narrow], { ...o, labels: ["5"], notes: ["180MS"] });
  assert.deepEqual(b.data, a.data, "too narrow: no note");
});
