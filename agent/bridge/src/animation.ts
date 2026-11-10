// Animation helpers (#42) and clean pixel-art rotation (shared with #43):
// rigid transforms of a part along an arc, squash and stretch, and smears,
// all without blending (no new colors).
import { nearest, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

/** RGBA packed as one unsigned number (0 outside the image). */
const get = (img: Rgba, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  const i = (y * img.width + x) * 4;
  return ((img.data[i] << 24) | (img.data[i + 1] << 16) | (img.data[i + 2] << 8) | img.data[i + 3]) >>> 0;
};

function put(out: Uint8Array, w: number, x: number, y: number, v: number) {
  const i = (y * w + x) * 4;
  out[i] = (v >>> 24) & 255;
  out[i + 1] = (v >>> 16) & 255;
  out[i + 2] = (v >>> 8) & 255;
  out[i + 3] = v & 255;
}

const opaqueV = (v: number) => (v & 255) >= 128;

/** Scale2x (EPX): doubles the image, sharpening diagonals without new colors. */
export function scale2x(img: Rgba): Rgba {
  const w = img.width, h = img.height, W = w * 2;
  const out = new Uint8Array(W * h * 2 * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const P = get(img, x, y), A = get(img, x, y - 1), B = get(img, x + 1, y), C = get(img, x - 1, y), D = get(img, x, y + 1);
      put(out, W, 2 * x, 2 * y, C === A && C !== D && A !== B ? A : P);
      put(out, W, 2 * x + 1, 2 * y, A === B && A !== C && B !== D ? B : P);
      put(out, W, 2 * x, 2 * y + 1, D === C && D !== B && C !== A ? C : P);
      put(out, W, 2 * x + 1, 2 * y + 1, B === D && B !== A && D !== C ? D : P);
    }
  }
  return { width: W, height: h * 2, data: out };
}

export interface Transform {
  dx?: number;
  dy?: number;
  /** Degrees, clockwise. */
  angle?: number;
  sx?: number;
  sy?: number;
  /** Pivot in source pixels (default: the center). */
  px?: number;
  py?: number;
}

/**
 * Transforms an image the RotSprite way: upscale x8 with Scale2x (so
 * rotated edges stay clean), sample each output pixel's center through the
 * inverse transform at the 8x size. No blending: every pixel is a source
 * color. Output has the same canvas size.
 */
export function transform(img: Rgba, t: Transform): Rgba {
  const w = img.width, h = img.height;
  const angle = ((t.angle ?? 0) * Math.PI) / 180;
  const sx = t.sx ?? 1, sy = t.sy ?? 1;
  const px = t.px ?? w / 2, py = t.py ?? h / 2;
  const needsSmooth = Math.abs(angle) > 1e-6 || Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6;
  const big = needsSmooth ? scale2x(scale2x(scale2x(img))) : img;
  const k = needsSmooth ? 8 : 1;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const shrink = sx < 0.999 || sy < 0.999;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Output pixel center -> source position (inverse of: scale, rotate about pivot, then move).
      const ox = x + 0.5 - px - (t.dx ?? 0), oy = y + 0.5 - py - (t.dy ?? 0);
      const rx = (cos * ox + sin * oy) / sx, ry = (-sin * ox + cos * oy) / sy;
      const srcX = (rx + px) * k, srcY = (ry + py) * k;
      let v = get(big, Math.floor(srcX), Math.floor(srcY));
      if (shrink) {
        // Shrinking: look at the whole footprint so thin lines (an outline,
        // a 1 px crossguard) don't fall between samples; take its most
        // common opaque color.
        const fx = (k / sx) * 0.45, fy = (k / sy) * 0.45;
        const counts = new Map<number, number>();
        for (let yy = srcY - fy; yy < srcY + fy; yy += 1) {
          for (let xx = srcX - fx; xx < srcX + fx; xx += 1) {
            const c = get(big, Math.floor(xx), Math.floor(yy));
            if (opaqueV(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
          }
        }
        let best = 0, bestN = 0;
        for (const [c, n] of counts) if (n > bestN) [best, bestN] = [c, n];
        v = bestN ? best : 0;
      }
      if (opaqueV(v)) put(out, w, x, y, v);
    }
  }
  return { width: w, height: h, data: out };
}

export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export function ease(t: number, e: Easing = "ease-in-out"): number {
  if (e === "ease-in") return t * t;
  if (e === "ease-out") return 1 - (1 - t) * (1 - t);
  if (e === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return t;
}

/**
 * The transform at time t (0..1) of a move from nothing to `to`, with the
 * path bent upward by `arc` px at the middle (a jump, a swing).
 */
export function along(to: Transform, t: number, arc = 0, easing: Easing = "ease-in-out"): Transform {
  const e = ease(t, easing);
  return {
    dx: (to.dx ?? 0) * e,
    dy: (to.dy ?? 0) * e - arc * 4 * t * (1 - t),
    angle: (to.angle ?? 0) * e,
    sx: 1 + ((to.sx ?? 1) - 1) * e,
    sy: 1 + ((to.sy ?? 1) - 1) * e,
    px: to.px,
    py: to.py,
  };
}

/** Bounding box of the opaque pixels. */
export function bounds(img: Rgba): { x: number; y: number; w: number; h: number } | undefined {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) {
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
 * Squash (amount < 0) or stretch (> 0) keeping the area, anchored at the
 * bottom center of the shape (it stays on the ground).
 */
export function squashStretch(img: Rgba, amount: number): Rgba {
  const b = bounds(img);
  if (!b) return img;
  const sy = 1 + amount, sx = 1 / sy;
  return transform(img, { sx, sy, px: b.x + b.w / 2, py: b.y + b.h });
}

/**
 * A smear frame: the shape moving from `from` to `to` drawn as a sweep, so
 * a fast move reads in one frame. Copies of the shape at `steps` points
 * along the motion, the leading copy on top.
 */
export function smear(from: Rgba, to: Rgba, steps = 6): Rgba {
  const a = bounds(from), b = bounds(to);
  const w = to.width, h = to.height;
  const out = new Uint8Array(w * h * 4);
  if (!a || !b) return { width: w, height: h, data: new Uint8Array(to.data) };
  const dx = b.x + b.w / 2 - (a.x + a.w / 2), dy = b.y + b.h / 2 - (a.y + a.h / 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // The trailing copies come from the end pose, shifted back along the path.
    const moved = transform(to, { dx: -dx * (1 - t), dy: -dy * (1 - t) });
    for (let p = 0; p < w * h * 4; p += 4) if (moved.data[p + 3] >= 128) out.set(moved.data.subarray(p, p + 4), p);
  }
  return { width: w, height: h, data: out };
}

/**
 * The drawing moved by a fraction of a pixel (#65): each pixel is sampled
 * between its neighbors (bilinear, alpha-weighted), then snapped to the
 * nearest of `colors`, so edges shift brightness instead of jumping a
 * whole pixel; that reads as sub-pixel motion in small sprites. The
 * silhouette moves where coverage crosses half.
 */
export function subpixelShift(img: Rgba, fx: number, fy: number, colors: RGBA[]): Rgba {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(data.length);
  const px = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : (y * w + x) * 4);
  const memo = new Map<number, RGBA>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - fx, sy = y - fy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]] as const) {
        const i = px(x0 + dx, y0 + dy);
        if (i < 0 || wt === 0) continue;
        const al = (data[i + 3] / 255) * wt;
        r += data[i] * al;
        g += data[i + 1] * al;
        b += data[i + 2] * al;
        a += al;
      }
      if (a < 0.5) continue;
      const key = (Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a);
      let c = memo.get(key);
      if (!c) {
        c = nearest({ r: Math.round(r / a), g: Math.round(g / a), b: Math.round(b / a), a: 255 }, colors).color;
        memo.set(key, c);
      }
      out.set([c.r, c.g, c.b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** The opaque colors of an image. */
export function imageColors(img: Rgba): RGBA[] {
  const seen = new Map<number, RGBA>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    if (!seen.has(k)) seen.set(k, { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 });
  }
  return [...seen.values()];
}
