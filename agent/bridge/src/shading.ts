// Ramps, auto-shading and outlines (#39).
import { fromOklab, fromOklch, hex, nearest, toOklab, toOklch, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

// ---------------------------------------------------------------------------
// Ramps
// ---------------------------------------------------------------------------

export interface RampOptions {
  steps?: number; // 2..9, default 5
  /** Degrees the hue turns from the darkest to the lightest step (shadows cool, highlights warm). Default 30. */
  hueShift?: number;
  /** Lightness of the darkest and lightest steps (OKLab L). Default around the base. */
  darkest?: number;
  lightest?: number;
  /** Chroma at the ends relative to the middle (pixel-art ramps lose saturation at the ends). Default 0.7. */
  endChroma?: number;
}

/**
 * A hue-shifted ramp through `base` (which stays one of the steps), dark to
 * light. Shadows turn toward blue/purple and highlights toward yellow, the
 * classic pixel-art ramp.
 */
export function makeRamp(base: RGBA, o: RampOptions = {}): RGBA[] {
  const steps = Math.max(2, Math.min(9, o.steps ?? 5));
  const b = toOklch(base);
  const darkest = o.darkest ?? Math.max(0.12, b.L - 0.32);
  const lightest = o.lightest ?? Math.min(0.97, b.L + 0.28);
  const baseIndex = Math.round(((b.L - darkest) / Math.max(1e-6, lightest - darkest)) * (steps - 1));
  const shift = o.hueShift ?? 30;
  const endC = o.endChroma ?? 0.7;
  // Warm direction: toward yellow (h ~ 100) for highlights; cool: toward blue (h ~ 265).
  const toward = (h: number, target: number, amount: number) => {
    let d = ((target - h + 540) % 360) - 180;
    return h + Math.sign(d) * Math.min(Math.abs(d), amount);
  };
  const out: RGBA[] = [];
  for (let i = 0; i < steps; i++) {
    if (i === Math.max(0, Math.min(steps - 1, baseIndex))) {
      out.push({ ...base, a: 255 });
      continue;
    }
    const t = i / (steps - 1); // 0 dark .. 1 light
    const L = darkest + (lightest - darkest) * t;
    const rel = (i - baseIndex) / Math.max(1, steps - 1); // <0 shadow, >0 highlight
    const h = rel < 0 ? toward(b.h, 265, (-rel) * shift * 2) : toward(b.h, 100, rel * shift * 2);
    const C = b.C * (1 - (1 - endC) * Math.abs(rel) * 2);
    out.push(fromOklch(L, Math.max(0, C), h));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

export type LightDir = "top-left" | "top" | "top-right" | "left" | "right" | "bottom-left" | "bottom" | "bottom-right";

const LIGHT: Record<LightDir, [number, number]> = {
  "top-left": [-1, -1], top: [0, -1], "top-right": [1, -1], left: [-1, 0], right: [1, 0],
  "bottom-left": [-1, 1], bottom: [0, 1], "bottom-right": [1, 1],
};

const idx = (img: Rgba, x: number, y: number) => (y * img.width + x) * 4;
const key = (img: Rgba, x: number, y: number) => {
  const i = idx(img, x, y);
  return img.data[i + 3] < 128 ? -1 : (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
};

/**
 * Distance (in pixels, 8-connected chamfer) from each opaque pixel to the
 * nearest pixel outside its shape (transparency, or another color when
 * `byColor`), 0 outside.
 */
export function distanceField(img: Rgba, byColor = false, skip?: Set<number>): Float64Array {
  const { width: w, height: h } = img;
  const d = new Float64Array(w * h);
  const INF = 1e9;
  const inside = (x: number, y: number, k: number) =>
    x >= 0 && y >= 0 && x < w && y < h && key(img, x, y) !== -1 && (!byColor || key(img, x, y) === k || skip?.has(key(img, x, y)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = key(img, x, y) === -1 || skip?.has(key(img, x, y)) ? 0 : INF;
  const pass = (xs: number[], ys: number[], nb: [number, number, number][]) => {
    for (const y of ys) for (const x of xs) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      const k = key(img, x, y);
      for (const [dx, dy, c] of nb) {
        const nx = x + dx, ny = y + dy;
        const nd = inside(nx, ny, k) ? d[ny * w + nx] + c : c - 0.5; // outside neighbor: half a step away
        if (nd < d[i]) d[i] = nd;
      }
    }
  };
  const xs = [...Array(w).keys()], ys = [...Array(h).keys()];
  pass(xs, ys, [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [1, -1, 1.414]]);
  pass(xs.slice().reverse(), ys.slice().reverse(), [[1, 0, 1], [0, 1, 1], [1, 1, 1.414], [-1, 1, 1.414]]);
  return d;
}

export interface ShadeOptions {
  light?: LightDir;
  /** Shade steps per color (2..5). Default 3. */
  bands?: number;
  /** Light the edge facing away from the light a little (rim light). */
  rim?: boolean;
  /** Treat each flat color as its own shape (default true); false shades the whole silhouette as one form. */
  perColor?: boolean;
  /** Colors left as they are (outline). */
  keep?: string[];
  /** Colors to snap the result to (the sprite palette), if any. */
  palette?: RGBA[];
}

/**
 * Shades a flat-colored sprite: each shape's form is estimated from its
 * distance field (a rounded bevel), lit from `light`, and each pixel takes
 * one of `bands` ramp steps built around its flat color. Outline colors
 * stay. Returns the new image and the ramps used.
 */
export function shadeFlat(img: Rgba, o: ShadeOptions = {}): { image: Rgba; ramps: Map<string, RGBA[]> } {
  const { width: w, height: h } = img;
  const bands = Math.max(2, Math.min(5, o.bands ?? 3));
  const [lx0, ly0] = LIGHT[o.light ?? "top-left"];
  const len = Math.hypot(lx0, ly0, 0.9);
  const lx = lx0 / len, ly = ly0 / len, lz = 0.9 / len;
  const keep = new Set((o.keep ?? []).map((k) => parseInt(k.slice(1, 7), 16)));
  const field = distanceField(img, o.perColor !== false, keep);
  const out = new Uint8Array(img.data);
  const ramps = new Map<string, RGBA[]>();
  // The largest depth per color, to normalize the bevel per shape.
  const maxDepth = new Map<number, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = key(img, x, y);
    if (k < 0 || keep.has(k)) continue;
    maxDepth.set(k, Math.max(maxDepth.get(k) ?? 0, field[y * w + x]));
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = key(img, x, y);
      if (k < 0 || keep.has(k)) continue;
      const base = { r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, a: 255 };
      const hk = hex(base);
      if (!ramps.has(hk)) {
        // Odd step count keeps the flat color in the middle of the ramp;
        // the range grows with the steps so 2-3 bands stay subtle.
        const steps = bands % 2 ? bands : bands + 1;
        const L0 = toOklch(base).L;
        const r = makeRamp(base, { steps, hueShift: 25, darkest: Math.max(0.1, L0 - 0.08 * (steps - 1)), lightest: Math.min(0.96, L0 + 0.07 * (steps - 1)) });
        ramps.set(hk, bands % 2 ? r : r.slice(1));
      }
      // Surface normal: the downhill direction of the distance field (outward), tilted up by depth.
      const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : field[yy * w + xx]);
      let gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1);
      const gl = Math.hypot(gx, gy) || 1;
      const depth = Math.min(1, field[y * w + x] / Math.max(1, maxDepth.get(k)! * 0.8));
      const nxy = Math.sqrt(Math.max(0, 1 - depth * depth));
      const nx = (-gx / gl) * nxy, ny = (-gy / gl) * nxy, nz = depth;
      let lum = nx * lx + ny * ly + nz * lz; // -1..1
      if (o.rim && nx * lx + ny * ly < -0.5 && depth < 0.35) lum += 0.35;
      const t = Math.max(0, Math.min(1, (lum + 0.2) / 1.2));
      const ramp = ramps.get(hk)!;
      let c = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
      if (o.palette?.length) c = nearest(c, o.palette).color;
      out.set([c.r, c.g, c.b, 255], idx(img, x, y));
    }
  }
  return { image: { width: w, height: h, data: out }, ramps };
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

export interface OutlineOptions {
  /** "outer" draws around the shape; "inner" recolors its edge pixels. Default outer. */
  mode?: "outer" | "inner";
  /** 4: no diagonals (rounder, the usual choice), 8: diagonals too. Default 4. */
  connectivity?: 4 | 8;
  /** A hex color, "selout" (a darker shade of the color each pixel borders) or "darkest" (the palette's darkest). */
  color?: string;
  palette?: RGBA[];
}

/** A darker shade of a color for selout outlines, snapped to the palette when given. */
export function darker(c: RGBA, palette?: RGBA[]): RGBA {
  const x = toOklch(c);
  let d = fromOklch(Math.max(0.08, x.L - 0.28), x.C * 0.9, ((x.h - 15) + 360) % 360);
  if (palette?.length) {
    // The nearest palette color that is actually darker.
    const darkerOnes = palette.filter((p) => toOklch(p).L < x.L - 0.08);
    if (darkerOnes.length) d = nearest(d, darkerOnes).color;
  }
  return d;
}

export function outline(img: Rgba, o: OutlineOptions = {}): Rgba {
  const { width: w, height: h } = img;
  const out = new Uint8Array(img.data);
  const nb = o.connectivity === 8
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && img.data[idx(img, x, y) + 3] >= 128;
  const get = (x: number, y: number): RGBA => {
    const i = idx(img, x, y);
    return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 };
  };
  let fixed: RGBA | undefined;
  if (!o.color || o.color === "darkest") {
    const pool = o.palette?.length ? o.palette : [{ r: 20, g: 16, b: 30, a: 255 }];
    fixed = pool.slice().sort((a, b) => toOklch(a).L - toOklch(b).L)[0];
  } else if (o.color !== "selout") {
    const v = parseInt(o.color.replace("#", "").slice(0, 6), 16);
    fixed = { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 };
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isOpaque = opaque(x, y);
      if (o.mode === "inner" ? !isOpaque : isOpaque) continue;
      // Outer: a transparent pixel next to the shape. Inner: an opaque pixel next to transparency.
      let neighbor: RGBA | undefined;
      for (const [dx, dy] of nb) {
        const nx = x + dx, ny = y + dy;
        if (o.mode === "inner" ? !opaque(nx, ny) : opaque(nx, ny)) {
          neighbor = o.mode === "inner" ? get(x, y) : get(nx, ny);
          break;
        }
      }
      if (!neighbor) continue;
      const c = fixed ?? darker(neighbor, o.palette);
      out.set([c.r, c.g, c.b, 255], idx(img, x, y));
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Manual anti-aliasing and ambient occlusion (#64)
// ---------------------------------------------------------------------------

/** The color halfway between two in OKLab, snapped to the palette when given. */
export function between(a: RGBA, b: RGBA, palette?: RGBA[], t = 0.5): RGBA {
  const x = toOklab(a), y = toOklab(b);
  const m = fromOklab({ L: x.L + (y.L - x.L) * t, a: x.a + (y.a - x.a) * t, b: x.b + (y.b - x.b) * t });
  return palette?.length ? nearest(m, palette).color : m;
}

/**
 * Manual anti-aliasing for jagged steps between two colors: a pixel whose
 * two perpendicular neighbors (e.g. above and left) share another color,
 * while its other two neighbors share its own, sits in the inner corner
 * of a step. It takes a color between the two, as pixel artists do by
 * hand. Only opaque pixels change (no blending into the background), and
 * corners on 1 px wide lines are left alone so lines don't thicken.
 */
export function antiAlias(img: Rgba, o: { palette?: RGBA[]; strength?: number } = {}): { image: Rgba; changed: number } {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(data.length);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : (y * w + x) * 4);
  const key = (i: number) => (i < 0 || data[i + 3] < 128 ? -1 : (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  let changed = 0;
  const pairs: [number, number][][] = [[[0, -1], [-1, 0]], [[0, -1], [1, 0]], [[0, 1], [-1, 0]], [[0, 1], [1, 0]]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = at(x, y), me = key(i);
      if (me < 0) continue;
      for (const [[ax, ay], [bx, by]] of pairs) {
        const a = key(at(x + ax, y + ay)), b = key(at(x + bx, y + by));
        if (a < 0 || a !== b || a === me) continue;
        // The opposite sides stay this pixel's color: a real step, not a spike.
        if (key(at(x - ax, y - ay)) !== me || key(at(x - bx, y - by)) !== me) continue;
        // The other color's diagonal neighbor is part of it too (not a 1 px line).
        if (key(at(x + ax + bx, y + ay + by)) !== a) continue;
        const ai = at(x + ax, y + ay);
        const c = between({ r: data[i], g: data[i + 1], b: data[i + 2], a: 255 }, { r: data[ai], g: data[ai + 1], b: data[ai + 2], a: 255 }, o.palette, 0.5 * (o.strength ?? 1));
        out.set([c.r, c.g, c.b, 255], i);
        changed++;
        break;
      }
    }
  }
  return { image: { width: w, height: h, data: out }, changed };
}

/**
 * Ambient occlusion from a height field (0..1 per pixel, 0 outside the
 * shape): a pixel is darker the more its neighbors within `radius` rise
 * above it (creases, where parts meet, the inside of curls). Returns the
 * occlusion per pixel quantized to `levels` steps (0 = open).
 */
export function ambientOcclusion(img: Rgba, height: Float64Array, o: { radius?: number; levels?: number; strength?: number } = {}): Uint8Array {
  const { width: w, height: h, data } = img;
  const r = Math.max(1, Math.round(o.radius ?? 2)), levels = Math.max(1, o.levels ?? 2), k = o.strength ?? 1;
  const occ = new Float64Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i * 4 + 3] < 128) continue;
      let sum = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        // Higher neighbors occlude; nearer ones count more.
        sum += Math.max(0, height[ny * w + nx] - height[i]) / Math.hypot(dx, dy);
        n++;
      }
      occ[i] = n ? sum / n : 0;
      max = Math.max(max, occ[i]);
    }
  }
  const out = new Uint8Array(w * h);
  if (max <= 0) return out;
  for (let i = 0; i < out.length; i++) {
    const v = Math.min(1, (occ[i] / max) * k);
    out[i] = v < 0.2 ? 0 : Math.min(levels, Math.ceil(v * levels));
  }
  return out;
}

/** Darkens each pixel one palette-aware step per occlusion level. */
export function applyOcclusion(img: Rgba, occ: Uint8Array, palette?: RGBA[]): Rgba {
  const out = new Uint8Array(img.data);
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i]) continue;
    let c: RGBA = { r: out[i * 4], g: out[i * 4 + 1], b: out[i * 4 + 2], a: 255 };
    for (let s = 0; s < occ[i]; s++) c = darker(c, palette);
    out.set([c.r, c.g, c.b], i * 4);
  }
  return { width: img.width, height: img.height, data: out };
}
