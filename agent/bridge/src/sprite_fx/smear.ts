// Smears and motion trails (#105): pure functions on RGBA frames. Motion comes from the layer's opaque-content
// centroid between two frames, optionally refined per block by block matching (sum of absolute differences over a
// small window) for parts that deform. Four looks are made from it:
// - sweep: the frame's mask stamped at every Bresenham step back along the motion, narrower towards the tail and
//   thinned with a checker at its far end, filled with colors taken from the art;
// - stretch: the frame stretched along the motion (nearest-neighbour, area roughly kept), its leading edge in place;
// - afterimage: copies at the previous positions, each one palette step darker and dithered with a checker;
// - multiples: sharp copies spread along the path, cartoon style.
// Every pixel written is a color of the art or of the given palette: no alpha blending, no new colors. Everything is
// deterministic. The SMEAR paper (Basset et al., SIGGRAPH 2024) and pixel-art smear tutorials were read for ideas
// only; no code from them (SMEAR's is GPL-3) is used.
import { distance, hex, toOklab, type RGBA } from "../color.js";
import { blank, OPAQUE, type Rgba } from "../image.js";
import { upscale8, type Point } from "./raster.js";

export type SmearMode = "sweep" | "stretch" | "afterimage" | "multiples";
export const SMEAR_MODES: SmearMode[] = ["sweep", "stretch", "afterimage", "multiples"];
export type SmearFill = "ramp" | "edge" | "source";

const opaqueAt = (img: Rgba, x: number, y: number) =>
  x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[(y * img.width + x) * 4 + 3] >= OPAQUE;

/** The mean position of the opaque pixels (pixel centres), or undefined when there are none. */
export function centroid(img: Rgba): Point | undefined {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] < OPAQUE) continue;
    sx += x + 0.5; sy += y + 0.5; n++;
  }
  return n ? { x: sx / n, y: sy / n } : undefined;
}

/** How the content moved from `prev` to `cur`: the centroid difference, or undefined when either is empty. */
export function motionVector(prev: Rgba, cur: Rgba): Point | undefined {
  const a = centroid(prev), b = centroid(cur);
  return a && b ? { x: b.x - a.x, y: b.y - a.y } : undefined;
}

/** Integer points from (0, 0) to (x, y), both ends included, one pixel per step (Bresenham's line). */
export function bresenham(x: number, y: number): Point[] {
  const out: Point[] = [];
  let x0 = 0, y0 = 0;
  const dx = Math.abs(x), dy = -Math.abs(y), sx = x > 0 ? 1 : -1, sy = y > 0 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === x && y0 === y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

/** Per-block motion: blocks of `block` px over the current frame, each with its own vector. */
export interface MotionField {
  block: number;
  cols: number;
  rows: number;
  /** Vector of each block (row-major), undefined where the block is empty. */
  vectors: (Point | undefined)[];
}

export interface BlockMatchOptions {
  /** Block size in px. Default 4. */
  block?: number;
  /** Search radius around the coarse vector, px. Default 3. */
  radius?: number;
  /** SAD window side (odd), px. Default 5. */
  window?: number;
}

/**
 * Block matching (implemented from the textbook description): for each block of `cur` holding content, the integer
 * displacement d near `coarse` that minimises the sum of absolute RGBA differences between `cur` around the block's
 * centre and `prev` at the same place minus d, with a small pull towards `coarse` so flat areas follow the whole
 * body. A block's vector says where its pixels came from: prev(p - d) ~ cur(p).
 */
export function blockMotion(prev: Rgba, cur: Rgba, coarse: Point, o: BlockMatchOptions = {}): MotionField {
  const block = o.block ?? 4, radius = o.radius ?? 3, half = Math.floor((o.window ?? 5) / 2);
  const cols = Math.ceil(cur.width / block), rows = Math.ceil(cur.height / block);
  const vectors: (Point | undefined)[] = [];
  const cx = Math.round(coarse.x), cy = Math.round(coarse.y);
  const px = (img: Rgba, x: number, y: number, k: number) =>
    x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 4 + k];
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    let any = false;
    for (let y = by * block; y < Math.min(cur.height, (by + 1) * block) && !any; y++)
      for (let x = bx * block; x < Math.min(cur.width, (bx + 1) * block); x++) if (opaqueAt(cur, x, y)) { any = true; break; }
    if (!any) { vectors.push(undefined); continue; }
    const mx = bx * block + (block >> 1), my = by * block + (block >> 1);
    let best = Infinity, bestD = { x: cx, y: cy };
    for (let dy = cy - radius; dy <= cy + radius; dy++) for (let dx = cx - radius; dx <= cx + radius; dx++) {
      let sad = 0;
      for (let wy = -half; wy <= half; wy++) for (let wx = -half; wx <= half; wx++) {
        const x = mx + wx, y = my + wy;
        // Alpha counts double so content against background weighs more than a shade change.
        sad += 2 * Math.abs(px(cur, x, y, 3) - px(prev, x - dx, y - dy, 3));
        for (let k = 0; k < 3; k++) sad += Math.abs(px(cur, x, y, k) - px(prev, x - dx, y - dy, k));
      }
      sad += 8 * (Math.abs(dx - cx) + Math.abs(dy - cy));
      // Strict < with this fixed scan order keeps the result deterministic.
      if (sad < best) { best = sad; bestD = { x: dx, y: dy }; }
    }
    vectors.push(bestD);
  }
  return { block, cols, rows, vectors };
}

/** The vector of the block holding (x, y), or `fallback`. */
export function fieldAt(f: MotionField | undefined, x: number, y: number, fallback: Point): Point {
  if (!f) return fallback;
  return f.vectors[Math.floor(y / f.block) * f.cols + Math.floor(x / f.block)] ?? fallback;
}

/** The longest vector of a field (how fast its fastest part moves), or 0. */
export function fieldSpeed(f: MotionField): number {
  let m = 0;
  for (const v of f.vectors) if (v) m = Math.max(m, Math.hypot(v.x, v.y));
  return m;
}

const colorAt = (img: Rgba, i: number): RGBA => ({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 });

/** Opaque colors of an image with counts, most used first (ties by hex, so the order is deterministic). */
function counts(img: Rgba, keep?: (x: number, y: number) => boolean): { c: RGBA; n: number }[] {
  const m = new Map<string, { c: RGBA; n: number }>();
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] < OPAQUE || (keep && !keep(x, y))) continue;
    const c = colorAt(img, i), k = hex(c), e = m.get(k);
    if (e) e.n++; else m.set(k, { c, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || (hex(a.c) < hex(b.c) ? -1 : 1));
}

/** The most used color of the content's boundary (opaque pixels next to a transparent one or the canvas edge). */
export function edgeColor(img: Rgba): RGBA | undefined {
  const edge = (x: number, y: number) => !opaqueAt(img, x - 1, y) || !opaqueAt(img, x + 1, y) || !opaqueAt(img, x, y - 1) || !opaqueAt(img, x, y + 1);
  return counts(img, edge)[0]?.c;
}

/** Up to `n` of the art's most used colors, lightest first: the sweep's fill from the head to the tail. */
export function artRamp(img: Rgba, n = 3): RGBA[] {
  return counts(img).slice(0, n).map((e) => e.c).sort((a, b) => toOklab(b).L - toOklab(a).L || (hex(a) < hex(b) ? -1 : 1));
}

/** The nearest color of `palette` that is darker than `c` (by OkLab lightness), or `c` when none is. */
export function darkerOf(c: RGBA, palette: RGBA[]): RGBA {
  const L = toOklab(c).L;
  let best: RGBA | undefined, d = Infinity;
  for (const p of palette) {
    if (toOklab(p).L >= L - 0.02) continue;
    const e = distance(c, p);
    if (e < d) { d = e; best = p; }
  }
  return best ? { r: best.r, g: best.g, b: best.b, a: 255 } : c;
}

/** A copy recolored `steps` palette steps darker (each step: the nearest darker palette color). */
export function darken(img: Rgba, palette: RGBA[], steps: number): Rgba {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  const memo = new Map<string, RGBA>();
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < OPAQUE) continue;
    const c = colorAt(out, i), k = hex(c);
    let d = memo.get(k);
    if (!d) { d = c; for (let s = 0; s < steps; s++) d = darkerOf(d, palette); memo.set(k, d); }
    out.data[i] = d.r; out.data[i + 1] = d.g; out.data[i + 2] = d.b;
  }
  return out;
}

/** Draws `top`'s opaque pixels, moved by (dx, dy), onto `base` (in place); `keep` can drop pixels (dithering). */
function drawOnto(base: Rgba, top: Rgba, dx: number, dy: number, keep?: (x: number, y: number) => boolean): void {
  const W = base.width, H = base.height;
  for (let y = 0; y < top.height; y++) for (let x = 0; x < top.width; x++) {
    const i = (y * top.width + x) * 4;
    if (top.data[i + 3] < OPAQUE) continue;
    const X = x + dx, Y = y + dy;
    if (X < 0 || Y < 0 || X >= W || Y >= H || (keep && !keep(X, Y))) continue;
    const o = (Y * W + X) * 4;
    base.data[o] = top.data[i]; base.data[o + 1] = top.data[i + 1]; base.data[o + 2] = top.data[i + 2]; base.data[o + 3] = 255;
  }
}

/** A checker that keeps one pixel in two (`phase` shifts it); `sparse` keeps one in four. */
export function checker(phase: number, sparse = false) {
  return sparse ? (x: number, y: number) => (x + phase) % 2 === 0 && (y + (phase >> 1)) % 2 === 0
    : (x: number, y: number) => (x + y + phase) % 2 === 0;
}

export interface SweepOptions {
  /** Trail length as a share of the motion, 0..2. Default 1. */
  length?: number;
  /** How much narrower the tail is, 0 (none) .. 1 (a point). Default 0.5. */
  taper?: number;
  /** Thin the far third of the trail with a checker. Default true. */
  thin?: boolean;
  fill?: SmearFill;
  /** Per-block motion for deforming parts (from blockMotion). */
  field?: MotionField;
}

/**
 * Sweep smear: the frame's mask stamped at every Bresenham step from where the content was (cur - v) to where it
 * is, under the frame's own art. Each step's copy is squeezed towards the content's centre line across the motion
 * as it trails (taper), and the far third is checkered (thin). With a field, each pixel trails along its block's
 * vector, so a swinging arm sweeps while the body barely moves.
 */
export function sweep(cur: Rgba, v: Point, o: SweepOptions = {}): Rgba {
  const len = o.length ?? 1, taper = Math.max(0, Math.min(1, o.taper ?? 0.5)), thin = o.thin ?? true;
  const fill = o.fill ?? "ramp";
  const out = blank(cur.width, cur.height);
  const c = centroid(cur);
  if (!c) return out;
  const ramp = fill === "ramp" ? artRamp(cur) : fill === "edge" ? [edgeColor(cur)!] : [];
  const mag = Math.hypot(v.x, v.y);
  const nx = mag ? -v.y / mag : 0, ny = mag ? v.x / mag : 1;
  // Per pixel: its trail vector; the number of steps is the longest trail's Bresenham length.
  let steps = 0;
  const trails: { x: number; y: number; i: number; vx: number; vy: number }[] = [];
  for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) {
    const i = (y * cur.width + x) * 4;
    if (cur.data[i + 3] < OPAQUE) continue;
    const pv = fieldAt(o.field, x, y, v);
    const vx = pv.x * len, vy = pv.y * len;
    steps = Math.max(steps, Math.round(Math.max(Math.abs(vx), Math.abs(vy))));
    trails.push({ x, y, i, vx, vy });
  }
  // Back to front: the farthest copy first, so nearer copies (and the art) draw over it. Step s puts every pixel
  // s/steps of the way back along its own trail: with one vector that is one pixel per step on the long axis, the
  // points of the Bresenham (DDA) line.
  for (let s = steps; s >= 1; s--) {
    const t = s / steps;
    const w = 1 - taper * t;
    const keep = thin && t > 2 / 3 ? checker(s) : undefined;
    const col = ramp.length ? ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))] : undefined;
    for (const p of trails) {
      let x = p.x + 0.5 - p.vx * t, y = p.y + 0.5 - p.vy * t;
      // Taper: squeeze the copy across the motion towards the centre line through the centroid.
      const u = (p.x + 0.5 - c.x) * nx + (p.y + 0.5 - c.y) * ny;
      x -= nx * u * (1 - w); y -= ny * u * (1 - w);
      const X = Math.floor(x), Y = Math.floor(y);
      if (X < 0 || Y < 0 || X >= cur.width || Y >= cur.height || (keep && !keep(X, Y))) continue;
      const o2 = (Y * cur.width + X) * 4;
      const src = col ?? colorAt(cur, p.i);
      out.data[o2] = src.r; out.data[o2 + 1] = src.g; out.data[o2 + 2] = src.b; out.data[o2 + 3] = 255;
    }
  }
  drawOnto(out, cur, 0, 0);
  return out;
}

/** Points on the Bresenham line from (0, 0) back along -v, spaced so `count` of them span it (the head excluded). */
function pathPoints(v: Point, count: number): Point[] {
  const line = bresenham(Math.round(-v.x), Math.round(-v.y));
  const out: Point[] = [];
  for (let j = 1; j <= count; j++) out.push(line[Math.round((j / count) * (line.length - 1))]);
  return out;
}

export interface StretchOptions {
  /** How much of the motion the stretch adds, 0..2. Default 1. */
  amount?: number;
  /** The longest stretch, as a factor of the content's length along the motion. Default 3. */
  max?: number;
}

/**
 * Stretch smear: the content stretched along v by s = 1 + amount·|v| / (its length along v), squeezed across by 1/s
 * (area roughly kept), its leading edge in place. An inverse map sampling the 8x Scale2x upscale, so diagonal
 * stretches stay clean and no new colors appear.
 */
export function stretch(cur: Rgba, v: Point, o: StretchOptions = {}): Rgba {
  const out = blank(cur.width, cur.height);
  const mag = Math.hypot(v.x, v.y), c = centroid(cur);
  if (!mag || !c) { drawOnto(out, cur, 0, 0); return out; }
  const ux = v.x / mag, uy = v.y / mag, nx = -uy, ny = ux;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) {
    if (!opaqueAt(cur, x, y)) continue;
    const a = (x + 0.5 - c.x) * ux + (y + 0.5 - c.y) * uy;
    lo = Math.min(lo, a - 0.5); hi = Math.max(hi, a + 0.5);
  }
  const extent = Math.max(1, hi - lo);
  const s = Math.min(o.max ?? 3, 1 + (o.amount ?? 1) * mag / extent), w = Math.max(0.34, 1 / s);
  // The anchor: the leading point (front along v) on the centre line.
  const ax = c.x + ux * hi, ay = c.y + uy * hi;
  const B = upscale8(cur);
  for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) {
    const qx = x + 0.5 - ax, qy = y + 0.5 - ay;
    const a = qx * ux + qy * uy, b = qx * nx + qy * ny;
    const fx = ax + ux * (a / s) + nx * (b / w), fy = ay + uy * (a / s) + ny * (b / w);
    if (fx < 0 || fy < 0 || fx >= cur.width || fy >= cur.height) continue;
    const X = Math.min(B.width - 1, Math.floor(fx * 8)), Y = Math.min(B.height - 1, Math.floor(fy * 8));
    const i = (Y * B.width + X) * 4;
    if (B.data[i + 3] < OPAQUE) continue;
    out.data.set(B.data.subarray(i, i + 3), (y * cur.width + x) * 4);
    out.data[(y * cur.width + x) * 4 + 3] = 255;
  }
  return out;
}

/**
 * Afterimages: `ghosts[j]` is the art one step further back (the previous frames' own art where known, else the
 * frame moved back along v), drawn under the frame, j + 1 palette steps darker, through a checker (the oldest
 * sparser). Oldest first, so newer ghosts cover older ones.
 */
export function afterimage(cur: Rgba, ghosts: Rgba[], palette: RGBA[]): Rgba {
  const out = blank(cur.width, cur.height);
  for (let j = ghosts.length - 1; j >= 0; j--) {
    const dark = darken(ghosts[j], palette, j + 1);
    drawOnto(out, dark, 0, 0, checker(j, j >= 2));
  }
  drawOnto(out, cur, 0, 0);
  return out;
}

/** The frame moved back along v by `count` evenly spaced Bresenham steps: afterimage ghosts without past frames. */
export function ghostsAlong(cur: Rgba, v: Point, count: number): Rgba[] {
  return pathPoints(v, count).map((p) => { const g = blank(cur.width, cur.height); drawOnto(g, cur, p.x, p.y); return g; });
}

/** Multiples: `copies` sharp copies of the frame spread back along v (the path's far end the last), under the art. */
export function multiples(cur: Rgba, v: Point, copies = 3): Rgba {
  const out = blank(cur.width, cur.height);
  const pts = pathPoints(v, copies);
  for (let j = pts.length - 1; j >= 0; j--) drawOnto(out, cur, pts[j].x, pts[j].y);
  drawOnto(out, cur, 0, 0);
  return out;
}

/** The set of opaque colors of images, as hex. */
export function colorSet(...imgs: Rgba[]): Set<string> {
  const s = new Set<string>();
  for (const img of imgs) for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= OPAQUE) s.add(hex(colorAt(img, i)));
  return s;
}
