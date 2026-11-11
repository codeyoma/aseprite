// Pixel-safe geometric transforms for the sprite effects (#104). A transform is an inverse map: each output pixel
// finds its source point and takes one source pixel, so no new colors appear. Rotation and fractional scales sample
// an 8x upscale made by three passes of Scale2x (EPX, reimplemented from Mazzoleni's description), the idea behind
// Xenowhirl's RotSprite (2007): diagonals stay clean instead of breaking into stairs. No GPL/AGPL code is used.
import { blank, bounds, OPAQUE, type Rect, type Rgba } from "../image.js";

/** Where a transform pivots, in sprite pixels (a point between pixels: 10 means the left edge of pixel 10). */
export interface Point { x: number; y: number }

/**
 * One frame's transform about a pivot: scale (sx, sy), then lean (top moves right by kx per pixel of height),
 * then rotation (radians, clockwise on screen), then the row wave (rows shifted sideways by wave(height above the
 * pivot) px), then the offset (dx, dy).
 */
export interface Warp {
  sx?: number;
  sy?: number;
  kx?: number;
  rot?: number;
  dx?: number;
  dy?: number;
  wave?: (height: number) => number;
}

const pixel = (img: Rgba, x: number, y: number) => {
  const i = (y * img.width + x) * 4, d = img.data;
  // Transparent pixels compare equal whatever their RGB.
  return d[i + 3] < OPAQUE ? 0 : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
};

/** One Scale2x (EPX) pass: each pixel becomes 2x2, rounding corners where two neighbours agree. */
export function scale2x(img: Rgba): Rgba {
  const { width: w, height: h } = img, W = w * 2;
  const out = new Uint8Array(W * h * 2 * 4);
  const at = (x: number, y: number) => pixel(img, Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y)));
  const put = (X: number, Y: number, v: number) => {
    const o = (Y * W + X) * 4;
    out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = at(x, y), a = at(x, y - 1), b = at(x + 1, y), c = at(x - 1, y), d = at(x, y + 1);
    put(2 * x, 2 * y, c === a && c !== d && a !== b ? a : p);
    put(2 * x + 1, 2 * y, a === b && a !== c && b !== d ? b : p);
    put(2 * x, 2 * y + 1, d === c && d !== b && c !== a ? c : p);
    put(2 * x + 1, 2 * y + 1, b === d && b !== a && d !== c ? d : p);
  }
  return { width: W, height: h * 2, data: out };
}

/** The 8x Scale2x upscale that rotations and fractional scales sample. */
export function upscale8(img: Rgba): Rgba {
  return scale2x(scale2x(scale2x(img)));
}

/** True when the warp only moves the image by whole pixels (no resampling needed). */
function onlyMoves(w: Warp): boolean {
  return (w.sx ?? 1) === 1 && (w.sy ?? 1) === 1 && !w.kx && !w.rot && !w.wave;
}

/**
 * The source image transformed by `warp` about `pivot`, at the source's size (what lands outside is cut).
 * `big` is upscale8(src), passed in so several frames share one upscale.
 */
export function warp(src: Rgba, w: Warp, pivot: Point, big?: Rgba): Rgba {
  const { width: W, height: H } = src;
  const out = blank(W, H);
  const dx = w.dx ?? 0, dy = w.dy ?? 0;
  if (onlyMoves(w)) {
    const ox = Math.round(dx), oy = Math.round(dy);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x - ox, sy = y - oy;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const i = (sy * W + sx) * 4;
      if (src.data[i + 3]) out.data.set(src.data.subarray(i, i + 4), (y * W + x) * 4);
    }
    return out;
  }
  const B = big ?? upscale8(src);
  const sxv = w.sx ?? 1, syv = w.sy ?? 1, kx = w.kx ?? 0, rot = w.rot ?? 0;
  const cos = Math.cos(-rot), sin = Math.sin(-rot);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // Output pixel centre relative to the pivot, then each step undone in reverse order.
    let px = x + 0.5 - pivot.x - dx, py = y + 0.5 - pivot.y - dy;
    if (w.wave) px -= w.wave(-py);
    const rx = px * cos - py * sin, ry = px * sin + py * cos;
    px = rx - kx * -ry; py = ry;
    if (Math.abs(sxv) < 1e-3 || Math.abs(syv) < 1e-3) continue;
    px /= sxv; py /= syv;
    const fx = px + pivot.x, fy = py + pivot.y;
    if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
    const X = Math.min(B.width - 1, Math.floor(fx * 8)), Y = Math.min(B.height - 1, Math.floor(fy * 8));
    const i = (Y * B.width + X) * 4;
    if (B.data[i + 3]) out.data.set(B.data.subarray(i, i + 4), (y * W + x) * 4);
  }
  return out;
}

/** Every opaque pixel turned to `color` (alpha kept): a hit flash. */
export function flash(src: Rgba, color: { r: number; g: number; b: number }, amount = 1): Rgba {
  const out = { width: src.width, height: src.height, data: new Uint8Array(src.data) };
  if (amount <= 0) return out;
  for (let i = 0; i < out.data.length; i += 4) {
    if (!out.data[i + 3]) continue;
    out.data[i] = color.r; out.data[i + 1] = color.g; out.data[i + 2] = color.b;
  }
  return out;
}

/** Where effects pivot on the content: the bottom centre (feet) or the centre of its opaque bounds. */
export function pivotOf(img: Rgba, at: "bottom" | "center" | "top" | Point): { pivot: Point; box?: Rect } {
  const box = bounds(img);
  if (typeof at === "object") return { pivot: at, box };
  if (!box) return { pivot: { x: img.width / 2, y: img.height / 2 } };
  const x = box.x + box.w / 2;
  if (at === "bottom") return { pivot: { x, y: box.y + box.h }, box };
  if (at === "top") return { pivot: { x, y: box.y }, box };
  return { pivot: { x, y: box.y + box.h / 2 }, box };
}

/** True when the content reaches the canvas edge, where a transform may have cut it. */
export function touchesEdge(img: Rgba): boolean {
  const b = bounds(img);
  return !!b && (b.x === 0 || b.y === 0 || b.x + b.w === img.width || b.y + b.h === img.height);
}
