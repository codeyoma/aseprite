// Shared tool inputs (tool_inputs.ts) against the fake document: frame
// specs, image sources and palettes by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentOf } from "../dist/document.js";
import { writePng } from "../dist/image.js";
import { findPalette } from "../dist/palettes.js";
import { framesInput, framesSpec, imageSource, readSource, resolvePalette, sourceKind } from "../dist/tool_inputs.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const W = 4, H = 4;
const sprite = () => fakeDocument({
  width: W, height: H, frames: 3, frame: 2, palette: ["#000000", "#ff000000", "#ffffff"], selection: { x: 1, y: 1, width: 2, height: 2 },
  layers: [
    { name: "Back", frames: [rect(W, H, [0, 0, 3, 3], [0, 0, 255]), rect(W, H, [0, 0, 3, 3], [0, 0, 254]), undefined] },
    { name: "Dot", frames: [undefined, rect(W, H, [1, 1, 1, 1], [255, 0, 0]), rect(W, H, [2, 2, 2, 2], [0, 255, 0])] },
  ],
});
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test("framesSpec takes a number, a list or a string; documents resolve it", async () => {
  for (const ok of [3, [1, 2], "1-2", "all"]) assert.ok(framesSpec.safeParse(ok).success, JSON.stringify(ok));
  assert.ok(!framesSpec.safeParse(1.5).success);
  assert.ok(framesInput("all frames").safeParse(undefined).success, "optional");
  assert.match(framesInput("all frames").description, /Default: all frames\./);
  const doc = documentOf(sprite());
  assert.deepEqual(await doc.frames("all"), [1, 2, 3]);
  assert.deepEqual(await doc.frames(), [2], "the active frame");
  await assert.rejects(doc.frames("2-5"), /out of range/);
});

test("imageSource: the kind follows source, path, then layer; a superset of both old schemas", async () => {
  assert.equal(sourceKind({}), "sprite");
  assert.equal(sourceKind({ path: "a.png" }), "file");
  assert.equal(sourceKind({ layer: "Dot" }), "layer");
  assert.equal(sourceKind({ path: "a.png", source: "layer", layer: "Dot" }), "layer");
  for (const old of [
    { source: "selection", layer: "L3", frames: "1-4" },     // color tools
    { source: "file", path: "x.png", frame: 2 },             // pixel tools
  ]) assert.ok(imageSource.safeParse(old).success, JSON.stringify(old));
});

test("readSource: sprite, layer, frame and frames", async () => {
  const doc = documentOf(sprite());
  let r = await readSource({}, doc);
  assert.equal(r.description, "the sprite");
  assert.deepEqual(px(r.image, 1, 1), [255, 0, 0, 255], "composite of the active frame (2)");
  r = await readSource({ source: "layer", layer: "Back" }, doc);
  assert.equal(r.description, "layer Back");
  assert.deepEqual(px(r.image, 1, 1), [0, 0, 254, 255]);
  r = await readSource({ layer: "Dot", frame: 3 }, doc);
  assert.deepEqual([px(r.image, 2, 2), r.frame], [[0, 255, 0, 255], 3]);
  r = await readSource({ layer: "Back", frames: "1-2" }, doc);
  assert.deepEqual([px(r.image, 0, 0), r.frame], [[0, 0, 255, 255], 1], "one image: the first of frames");
  r = await readSource({ source: "sprite", layer: "Dot" }, doc);
  assert.deepEqual(px(r.image, 0, 0), [0, 0, 254, 255], "'sprite' reads every visible layer");
});

test("readSource: the selection is cut out with its place", async () => {
  const r = await readSource({ source: "selection" }, documentOf(sprite()));
  assert.equal(r.description, "the selection");
  assert.deepEqual([r.image.width, r.image.height, r.x, r.y], [2, 2, 1, 1]);
  assert.deepEqual(px(r.image, 0, 0), [255, 0, 0, 255]);
  const none = fakeDocument({ width: 2, height: 2, layers: [{ name: "A", frames: [rect(2, 2, [0, 0, 1, 1], [9, 9, 9])] }] });
  const all = await readSource({ source: "selection" }, documentOf(none));
  assert.deepEqual([all.image.width, all.x], [2, 0], "no selection: the whole image");
});

test("readSource: a PNG file, and only PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inputs-"));
  const path = join(dir, "a.png");
  writePng(path, { width: 2, height: 1, data: new Uint8Array([1, 2, 3, 255, 0, 0, 0, 0]) });
  const doc = documentOf(sprite());
  const r = await readSource({ path }, doc);
  assert.deepEqual([r.image.width, r.image.height, r.description], [2, 1, path]);
  assert.deepEqual(px(r.image, 0, 0), [1, 2, 3, 255]);
  await assert.rejects(readSource({ path: join(dir, "a.jpg") }, doc), /Only PNG files/);
  await assert.rejects(readSource({ source: "file" }, doc), /needs a path/);
});

test("resolvePalette: none, the sprite's, a known one by name", async () => {
  const doc = documentOf(sprite());
  assert.equal(await resolvePalette(undefined, doc), undefined);
  assert.equal(await resolvePalette("none", doc), undefined);
  const own = await resolvePalette("sprite", doc);
  assert.deepEqual(own.map((c) => [c.r, c.g, c.b]), [[0, 0, 0], [255, 255, 255]], "transparent entries skipped");
  assert.deepEqual(await resolvePalette("pico8", doc), findPalette("PICO-8").colors, "names match loosely");
  await assert.rejects(resolvePalette("no such palette", doc), /Could not reach Lospec for .no-such'.*offline/, "unknown names try Lospec; npm test has no network");
});
