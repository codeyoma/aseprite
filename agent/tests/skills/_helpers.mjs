// Shared pieces for the skill evals: the fake document (the bridge tests'
// one, which answers every request the document module sends), PNG writing,
// temp dirs and pixel helpers. Not an eval itself (no skill has this name).
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDocument, hex, rect } from "../../bridge/test/helpers/fake_document.mjs";

const require = createRequire(import.meta.url);
export const { PNG } = require("../../bridge/node_modules/pngjs");

export { fakeDocument, hex, rect };

/** A fresh temp dir for one eval's files. */
export const tempDir = (name) => mkdtempSync(join(tmpdir(), `skill-eval-${name}-`));

/** Writes an RGBA image as a PNG. */
export function writePng(path, { width, height, data }) {
  const png = new PNG({ width, height });
  png.data.set(data);
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

/** Nearest-neighbor upscale. */
export function upscale({ width, height, data }, k) {
  const out = new Uint8Array(width * k * height * k * 4);
  for (let y = 0; y < height * k; y++) for (let x = 0; x < width * k; x++) {
    const s = (Math.floor(y / k) * width + Math.floor(x / k)) * 4;
    out.set(data.subarray(s, s + 4), (y * width * k + x) * 4);
  }
  return { width: width * k, height: height * k, data: out };
}

/** Opaque colors in an RGBA buffer as a Set of '#rrggbb'. */
export function colorsOf(data) {
  const s = new Set();
  if (!data) return s;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) s.add(hex(data[i], data[i + 1], data[i + 2]));
  return s;
}

/** Number of opaque pixels. */
export function opaque(data) {
  let n = 0;
  if (data) for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
}

/** The text of a tool result. */
export const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Bounding box of opaque pixels: { x0, y0, x1, y1, w, h } or undefined. */
export function bounds(data, width) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  if (data) for (let i = 0; i < data.length; i += 4) if (data[i + 3]) {
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? undefined : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
