// image.ts: the shared image operations and their one alpha rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blank, bounds, decodePng, encodePng, OPAQUE, readPng, scale, snapToPalette, stamp, trim, writePng } from "../dist/image.js";

/** An image from rows of pixels, each [r, g, b, a]. */
const img = (rows) => ({ width: rows[0].length, height: rows.length, data: Uint8Array.from(rows.flat(2)) });
const rowsOf = (im) => Array.from({ length: im.height }, (_, y) =>
  Array.from({ length: im.width }, (_, x) => [...im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)]));

const _ = [0, 0, 0, 0];
const R = [255, 0, 0, 255];
const G = [0, 255, 0, 255];
const FAINT = [9, 9, 9, 1]; // alpha 1: content only for a threshold of 1
const EDGE = [7, 7, 7, 127]; // just below OPAQUE
const HALF = [5, 5, 5, 128]; // exactly OPAQUE

test("the alpha rule: OPAQUE is 128", () => {
  assert.equal(OPAQUE, 128);
});

test("blank: transparent pixels of the given size", () => {
  assert.deepEqual(blank(2, 1), { width: 2, height: 1, data: new Uint8Array(8) });
  assert.deepEqual(blank(0, 0), { width: 0, height: 0, data: new Uint8Array(0) });
});

test("bounds: alpha >= 128 by default, any alpha with a threshold of 1", () => {
  const im = img([
    [_, FAINT, _, _],
    [_, _, HALF, _],
    [_, EDGE, R, _],
    [_, _, _, _],
  ]);
  assert.deepEqual(bounds(im), { x: 2, y: 1, w: 1, h: 2 });
  assert.deepEqual(bounds(im, 1), { x: 1, y: 0, w: 2, h: 3 });
  assert.equal(bounds(img([[_, EDGE], [FAINT, _]])), undefined);
  assert.deepEqual(bounds(img([[_, EDGE], [FAINT, _]]), 1), { x: 0, y: 0, w: 2, h: 2 });
});

test("bounds: empty and zero-size images have none", () => {
  assert.equal(bounds(blank(3, 2)), undefined);
  assert.equal(bounds(blank(3, 2), 1), undefined);
  assert.equal(bounds(blank(0, 0)), undefined);
});

test("trim: crops to the content and says where it was", () => {
  const im = img([
    [_, _, _, _],
    [_, R, EDGE, _],
    [_, _, G, _],
  ]);
  const t = trim(im);
  assert.deepEqual({ x: t.x, y: t.y, width: t.width, height: t.height }, { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual(rowsOf(t), [[R, EDGE], [_, G]]);
  // Below the threshold counts as empty: only the faint pixel is left out.
  const f = trim(img([[FAINT, _, _], [_, _, R]]), 1);
  assert.deepEqual({ x: f.x, y: f.y }, { x: 0, y: 0 });
  assert.deepEqual(rowsOf(f), [[FAINT, _, _], [_, _, R]]);
  assert.deepEqual(rowsOf(trim(img([[FAINT, _, _], [_, _, R]]))), [[R]]);
});

test("trim: an image with no content comes back whole at 0, 0", () => {
  const im = img([[EDGE, _], [_, FAINT]]);
  const t = trim(im);
  assert.deepEqual(t, { ...im, x: 0, y: 0 });
  assert.equal(t.data, im.data);
  assert.deepEqual(trim(blank(0, 0)), { width: 0, height: 0, data: new Uint8Array(0), x: 0, y: 0 });
});

test("scale: whole-factor nearest neighbor, with padding", () => {
  const im = img([[R, G]]);
  assert.deepEqual(rowsOf(scale(im, 2)), [[R, R, G, G], [R, R, G, G]]);
  assert.deepEqual(rowsOf(scale(im, 1, 1, 1)), [[_, _, _], [_, R, G]]);
  assert.deepEqual(rowsOf(scale(img([[R], [G]]), 2, 1, 0)), [[_, R, R], [_, R, R], [_, G, G], [_, G, G]]);
  assert.equal(scale(im, 1), im);
  assert.equal(scale(im, 0), im);
  assert.deepEqual(scale(blank(0, 0), 3), { width: 0, height: 0, data: new Uint8Array(0) });
});

test("stamp: copies opaque pixels only, clipped, without touching the base", () => {
  const base = img([[G, G, G], [G, G, G]]);
  const top = img([[R, EDGE], [HALF, FAINT]]);
  const out = stamp(base, top, 2, 0);
  assert.deepEqual(rowsOf(out), [[G, G, R], [G, G, HALF]]);
  assert.deepEqual(rowsOf(stamp(base, top, 1, 0)), [[G, R, G], [G, HALF, G]]);
  assert.deepEqual(rowsOf(stamp(base, top, -1, -1)), [[G, G, G], [G, G, G]]);
  assert.deepEqual(rowsOf(base), [[G, G, G], [G, G, G]]);
  assert.deepEqual(stamp(blank(0, 0), top, 0, 0), blank(0, 0));
});

test("snapToPalette: nearest palette RGB for opaque pixels, alpha kept", () => {
  const pal = [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }];
  const im = img([[[30, 20, 10, 255], [240, 250, 230, 200], [200, 200, 200, 127], [10, 10, 10, 128]]]);
  const out = snapToPalette(im, pal);
  assert.deepEqual(rowsOf(out), [[[0, 0, 0, 255], [255, 255, 255, 200], [200, 200, 200, 127], [0, 0, 0, 128]]]);
  assert.notEqual(out.data, im.data);
  assert.deepEqual(rowsOf(im)[0][0], [30, 20, 10, 255]);
  assert.deepEqual(snapToPalette(blank(0, 0), pal), blank(0, 0));
});

test("PNG: round trip through bytes and files, alpha edges intact", () => {
  const im = img([[R, FAINT, EDGE], [HALF, _, G]]);
  const back = decodePng(encodePng(im));
  assert.deepEqual(rowsOf(back), rowsOf(im));
  const dir = mkdtempSync(join(tmpdir(), "image-"));
  writePng(join(dir, "a.png"), im);
  assert.deepEqual(rowsOf(readPng(join(dir, "a.png"))), rowsOf(im));
  assert.deepEqual(rowsOf(readPng(join(dir, "a.png"), "not a png")), rowsOf(im));
});

test("readPng: the caller's message for a path that isn't .png", () => {
  const dir = mkdtempSync(join(tmpdir(), "image-"));
  writeFileSync(join(dir, "a.jpg"), "x");
  assert.throws(() => readPng(join(dir, "a.jpg"), "Only PNG sheets can be read"), { message: "Only PNG sheets can be read" });
  assert.throws(() => readPng(join(dir, "a.jpg")), (e) => e.message !== "Only PNG sheets can be read");
});
