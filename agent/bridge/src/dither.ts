// Dithering and palette swaps (#48).
import { hex, nearest, toOklab, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

export const BAYER2 = [[0, 2], [3, 1]].map((r) => r.map((v) => (v + 0.5) / 4));
export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));
export const CHECKER = [[0.25, 0.75], [0.75, 0.25]];

export type Pattern = "bayer2" | "bayer4" | "checker";
const MATRIX: Record<Pattern, number[][]> = { bayer2: BAYER2, bayer4: BAYER4, checker: CHECKER };

export function threshold(pattern: Pattern, x: number, y: number): number {
  const m = MATRIX[pattern];
  return m[y % m.length][x % m[0].length];
}

/**
 * The palette color for value t (0..1) along a ramp of colors, ordered
 * dithered: between the two steps t falls between, the pattern decides
 * which one each pixel takes.
 */
export function ditherRamp(ramp: RGBA[], t: number, x: number, y: number, pattern: Pattern): RGBA {
  if (ramp.length === 1) return ramp[0];
  const pos = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const f = pos - i;
  return f > threshold(pattern, x, y) ? ramp[i + 1] : ramp[i];
}

export interface GradientOptions {
  /** Colors from start to end (2+), e.g. a ramp. */
  colors: RGBA[];
  direction?: "horizontal" | "vertical" | "radial" | "diagonal";
  pattern?: Pattern;
  /** Area to fill (default: the whole canvas); only these pixels are drawn. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Optional mask: fill only where this image is opaque. */
  mask?: Rgba;
}

/** A dithered gradient between palette colors (only those colors appear). */
export function ditherGradient(width: number, height: number, o: GradientOptions): Rgba {
  const out = new Uint8Array(width * height * 4);
  const r = o.rect ?? { x: 0, y: 0, w: width, h: height };
  const pattern = o.pattern ?? "bayer4";
  for (let y = r.y; y < r.y + r.h && y < height; y++) {
    for (let x = r.x; x < r.x + r.w && x < width; x++) {
      if (o.mask && o.mask.data[(y * width + x) * 4 + 3] < 128) continue;
      const u = r.w > 1 ? (x - r.x) / (r.w - 1) : 0, v = r.h > 1 ? (y - r.y) / (r.h - 1) : 0;
      const t = o.direction === "vertical" ? v
        : o.direction === "radial" ? Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.5)
        : o.direction === "diagonal" ? (u + v) / 2 : u;
      const c = ditherRamp(o.colors, t, x, y, pattern);
      out.set([c.r, c.g, c.b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

/**
 * Converts an image to a palette with ordered dithering: each pixel
 * between its two nearest palette colors takes one or the other by its
 * position between them and the pattern, so smooth gradients become
 * dithered ones instead of flat bands.
 */
export function ditherToPalette(img: Rgba, palette: RGBA[], pattern: Pattern = "bayer4", strength = 1): Rgba {
  const out = new Uint8Array(img.data.length);
  const cache = new Map<number, [RGBA, RGBA, number]>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 128) continue;
      const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      let e = cache.get(key);
      if (!e) {
        const c = { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 };
        const a = nearest(c, palette);
        const rest = palette.filter((_, k) => k !== a.index);
        const b = rest.length ? nearest(c, rest) : a;
        // Position of c between a and b in OKLab (0 = a, 1 = b).
        const pa = toOklab(a.color), pb = toOklab(b.color), pc = toOklab(c);
        const ab = [pb.L - pa.L, pb.a - pa.a, pb.b - pa.b];
        const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((pc.L - pa.L) * ab[0] + (pc.a - pa.a) * ab[1] + (pc.b - pa.b) * ab[2]) / len2));
        // Dither only when the color really lies between the two (close to
        // the line from one to the other), not for an unrelated hue.
        const off = Math.hypot(pc.L - (pa.L + t * ab[0]), pc.a - (pa.a + t * ab[1]), pc.b - (pa.b + t * ab[2]));
        e = [a.color, b.color, off < 0.06 ? t * strength : 0];
        cache.set(key, e);
      }
      const c = e[2] > threshold(pattern, x, y) ? e[1] : e[0];
      out.set([c.r, c.g, c.b, 255], i);
    }
  }
  return { width: img.width, height: img.height, data: out };
}

// ---------------------------------------------------------------------------
// Palette swaps
// ---------------------------------------------------------------------------

/** A color map that sends each `from` ramp step to the matching `to` step (by position). */
export function rampMap(from: RGBA[], to: RGBA[]): Map<string, RGBA> {
  const map = new Map<string, RGBA>();
  from.forEach((c, i) => {
    const j = from.length === 1 ? 0 : Math.round((i / (from.length - 1)) * (to.length - 1));
    map.set(hex(c), to[j]);
  });
  return map;
}

export function applyMap(img: Rgba, map: Map<string, RGBA>): Rgba {
  const out = new Uint8Array(img.data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] < 128) continue;
    const to = map.get(hex({ r: out[i], g: out[i + 1], b: out[i + 2], a: 255 }));
    if (to) out.set([to.r, to.g, to.b], i);
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Palette-swap data for shaders: an index map (each pixel's index into the
 * base palette in the red channel, alpha kept) and a lookup table with one
 * row per variant (row 0 = the base palette).
 */
export function paletteLut(img: Rgba, base: RGBA[], variants: Map<string, RGBA>[]): { index: Rgba; lut: Rgba; missing: number } {
  const lookup = new Map(base.map((c, i) => [hex(c), i]));
  const index = new Uint8Array(img.data.length);
  let missing = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    let k = lookup.get(hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 }));
    if (k === undefined) {
      missing++;
      k = nearest({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 }, base).index;
    }
    index.set([k, 0, 0, img.data[i + 3]], i);
  }
  const rows = variants.length + 1;
  const lut = new Uint8Array(base.length * rows * 4);
  base.forEach((c, i) => lut.set([c.r, c.g, c.b, 255], i * 4));
  variants.forEach((v, r) => base.forEach((c, i) => {
    const to = v.get(hex(c)) ?? c;
    lut.set([to.r, to.g, to.b, 255], ((r + 1) * base.length + i) * 4);
  }));
  return { index: { width: img.width, height: img.height, data: index }, lut: { width: base.length, height: rows, data: lut }, missing };
}

/** What a palette-swap shader does: color = lut[row][index.r]. */
export function applyLut(index: Rgba, lut: Rgba, row: number): Rgba {
  const out = new Uint8Array(index.data.length);
  for (let i = 0; i < out.length; i += 4) {
    if (!index.data[i + 3]) continue;
    const j = (row * lut.width + index.data[i]) * 4;
    out.set([lut.data[j], lut.data[j + 1], lut.data[j + 2], index.data[i + 3]], i);
  }
  return { width: index.width, height: index.height, data: out };
}
