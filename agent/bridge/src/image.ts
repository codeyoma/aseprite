// Basic RGBA image operations shared by the bridge: the image type, a blank
// canvas, opaque bounds and trimming, nearest-neighbor scaling, stamping one
// image onto another, snapping to a palette, and PNG files.
//
// Alpha policy: a pixel is opaque (counts as content) when its alpha is at
// least OPAQUE (128). bounds, trim and stamp use that rule by default; a
// caller that needs another rule passes its own threshold (export's sheet
// trimming passes 1, so any pixel with non-zero alpha counts).
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { nearest, type RGBA } from "./color.js";

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Buffer; // RGBA, row-major
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The lowest alpha that counts as opaque. */
export const OPAQUE = 128;

/** A fully transparent image. */
export function blank(width: number, height: number): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Bounding box of the pixels with alpha >= minAlpha, or undefined when there are none. */
export function bounds(img: Rgba, minAlpha = OPAQUE): Rect | undefined {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Removes the rows and columns around the content (pixels with alpha >=
 * minAlpha); x, y is where the result sat in the image. An image with no
 * content comes back as it is, at 0, 0.
 */
export function trim(img: Rgba, minAlpha = OPAQUE): Rgba & { x: number; y: number } {
  const b = bounds(img, minAlpha);
  if (!b) return { ...img, x: 0, y: 0 };
  const { width: w, data } = img;
  const out = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    out.set(data.subarray(((y + b.y) * w + b.x) * 4, ((y + b.y) * w + b.x + b.w) * 4), y * b.w * 4);
  }
  return { width: b.w, height: b.h, data: out, x: b.x, y: b.y };
}

/**
 * Nearest-neighbor scale by a whole factor s, with optional transparent
 * padding at the left (padX) and top (padY). A factor of 1 or less without
 * padding returns the image itself.
 */
export function scale(img: Rgba, s: number, padX = 0, padY = 0): Rgba {
  if (s <= 1 && !padX && !padY) return img;
  const w = img.width * s + padX, h = img.height * s + padY;
  const out = new Uint8Array(w * h * 4);
  for (let y = padY; y < h; y++) {
    for (let x = padX; x < w; x++) {
      const i = (Math.floor((y - padY) / s) * img.width + Math.floor((x - padX) / s)) * 4;
      out.set(img.data.subarray(i, i + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** A copy of `base` with the opaque pixels of `top` copied over it at (x, y), clipped to `base`. */
export function stamp(base: Rgba, top: Rgba, x: number, y: number): Rgba {
  const out = new Uint8Array(base.data);
  for (let yy = 0; yy < top.height; yy++) for (let xx = 0; xx < top.width; xx++) {
    const i = (yy * top.width + xx) * 4;
    const X = x + xx, Y = y + yy;
    if (top.data[i + 3] < OPAQUE || X < 0 || Y < 0 || X >= base.width || Y >= base.height) continue;
    out.set(top.data.subarray(i, i + 4), (Y * base.width + X) * 4);
  }
  return { width: base.width, height: base.height, data: out };
}

/**
 * A copy of the image with every opaque pixel's RGB replaced by the nearest
 * palette color (OKLab, via color.ts); alpha and transparent pixels stay.
 */
export function snapToPalette(img: Rgba, palette: RGBA[]): Rgba {
  const d = new Uint8Array(img.data);
  const memo = new Map<number, RGBA>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < OPAQUE) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let c = memo.get(k);
    if (!c) {
      c = nearest({ r: d[i], g: d[i + 1], b: d[i + 2], a: 255 }, palette).color;
      memo.set(k, c);
    }
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
  }
  return { width: img.width, height: img.height, data: d };
}

/** Decodes PNG bytes (any PNG color type) into RGBA. */
export function decodePng(buf: Buffer): Rgba & { data: Buffer } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

/** Encodes RGBA as PNG bytes. */
export function encodePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  return PNG.sync.write(png);
}

/**
 * Reads a PNG file. With `notPng`, a path that doesn't end in .png throws
 * that message before anything is read (each tool words it for its input).
 */
export function readPng(path: string, notPng?: string): Rgba {
  if (notPng !== undefined && !/\.png$/i.test(path)) throw new Error(notPng);
  return decodePng(readFileSync(path));
}

/** Writes an image as a PNG file (the folder must exist). */
export function writePng(path: string, img: Rgba): void {
  writeFileSync(path, encodePng(img));
}
