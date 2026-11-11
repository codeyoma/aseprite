// Effect pipelines (#107): an effect described as a JSON chain of steps over a layer's frames or a blank canvas,
// node-graph style without the graph UI (research: docs/fx-algorithms-research.md §4). A pipeline is
// { name, source, frames, fps, loop, seed, palette, steps }; each step is { type, ...params } and any numeric param
// may be animated over the effect's normalized time t (a number, { from, to, ease } or { keys: [[t, v], ...], ease }).
// Every frame runs the whole chain on an RGBA buffer at native resolution; at the end every opaque pixel is snapped
// to the allowed colors (the palette, the colors the steps name, and the source's own colors) and alpha is made
// 0 or 255, so only palette colors are written. Same pipeline and seed, same frames.
//
// Steps live in a registry (STEP_TYPES): a zod schema and a run function per type. Adding a step type (the smear
// and fluid steps of #105 and #106) is one registerStep call; the schema and the tool pick it up.
import * as z from "zod/v4";
import { fromOklab, hex, nearest, parseHex, toOklab, type RGBA } from "../color.js";
import { ditherToPalette, threshold, type Pattern } from "../dither.js";
import { blank, bounds, OPAQUE, type Rgba } from "../image.js";
import { darker } from "../shading.js";
import { EASES, ease, type Ease } from "./curves.js";
import { JUICE_EFFECTS, juicePlan, type JuiceEffect } from "./juice.js";
import { NOISE_KINDS, Noise, field, type NoiseKind } from "./noise.js";
import { flash as flashImage, pivotOf, upscale8, warp } from "./raster.js";

export const PIPELINE_LIMITS = { size: 256, frames: 48, steps: 16, palette: 64, json: 16384, keys: 16 };

// ---------------------------------------------------------------------------
// Animated parameters
// ---------------------------------------------------------------------------

/** A number, a tween { from, to, ease }, or keyframes { keys: [[t, value], ...], ease } over t in 0..1. */
export type Anim = number | { from: number; to: number; ease?: Ease } | { keys: [number, number][]; ease?: Ease };

const isAnimObject = (v: unknown): v is Exclude<Anim, number> =>
  !!v && typeof v === "object" && !Array.isArray(v) && (("from" in v && "to" in v) || "keys" in v);

/** The value of an animated parameter at t (0..1). */
export function animAt(a: Anim | undefined, t: number, fallback = 0): number {
  if (a === undefined) return fallback;
  if (typeof a === "number") return a;
  const e = a.ease ?? "linear";
  if ("keys" in a) {
    const k = a.keys;
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i][0]) {
        const span = k[i][0] - k[i - 1][0], u = span > 0 ? (t - k[i - 1][0]) / span : 1;
        return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * ease(e, u);
      }
    }
    return k[k.length - 1][1];
  }
  return a.from + (a.to - a.from) * ease(e, t);
}

/** Every animated value in a step's params replaced by its value at t (nested objects too; arrays stay). */
export function paramsAt<T>(params: T, t: number): T {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    out[k] = isAnimObject(v) ? animAt(v as Anim, t) : v && typeof v === "object" && !Array.isArray(v) ? paramsAt(v, t) : v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Schema helpers: messages name the field, paths come from zod
// ---------------------------------------------------------------------------

const num = (min: number, max: number, what: string, int = false) => {
  let s = z.number(`${what} must be a number`);
  if (int) s = s.int(`${what} must be a whole number`);
  return s.min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`);
};
const easeEnum = z.enum(EASES as [Ease, ...Ease[]], `ease must be one of ${EASES.join(", ")}`);

/** An animatable number in [min, max]: a number, { from, to, ease? } or { keys: [[t, v], ...], ease? }. */
export function anim(min: number, max: number, what: string, int = false) {
  const n = num(min, max, what, int);
  const tween = z.object({ from: n, to: n, ease: easeEnum.optional() }).strict();
  const keys = z.object({
    keys: z.array(z.tuple([num(0, 1, `${what} key time`), n]), `${what} keys are [[t, value], ...] with t in 0..1`)
      .min(2, `${what} needs at least 2 keys`).max(PIPELINE_LIMITS.keys, `${what} has at most ${PIPELINE_LIMITS.keys} keys`)
      .refine((k) => k.every((p, i) => i === 0 || p[0] >= k[i - 1][0]), `${what} key times must not go down`),
    ease: easeEnum.optional(),
  }).strict();
  return dispatch((v) => typeof v === "number" ? n : v && typeof v === "object" && !Array.isArray(v) && "keys" in v ? keys
    : v && typeof v === "object" && !Array.isArray(v) ? tween
    : `${what} must be a number, { from, to, ease? } or { keys: [[t, value], ...] }`) as unknown as z.ZodType<Anim>;
}

/**
 * A value checked by the schema `choose` picks for it (or failed with the message it returns), with that schema's
 * issues kept at their paths: clear messages where a zod union would only say "Invalid input".
 */
function dispatch(choose: (v: unknown) => z.ZodType | string) {
  return z.unknown().transform((v, ctx) => {
    const s = choose(v);
    if (typeof s === "string") {
      ctx.issues.push({ code: "custom", message: s, input: v, path: [] });
      return z.NEVER;
    }
    const r = s.safeParse(v);
    if (r.success) return r.data;
    for (const i of r.error.issues) ctx.issues.push({ code: "custom", message: i.message, input: v, path: i.path });
    return z.NEVER;
  });
}

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, "a color is '#rrggbb'");
/** A palette step (0 darkest, -1 brightest, of the working palette sorted by lightness) or a hex color. */
const colorRef = (what: string, extra: readonly string[] = []) => dispatch((v) =>
  typeof v === "number" ? z.number().int(`${what}: a palette step is a whole number (0 darkest, -1 brightest)`)
    : typeof v === "string" && extra.includes(v) ? z.string()
    : typeof v === "string" ? hexColor
    : `${what} is a palette step (0 darkest, -1 brightest) or '#rrggbb'${extra.length ? ` or one of ${extra.join(", ")}` : ""}`) as unknown as z.ZodType<number | string>;
const ramp = (what: string) => z.array(hexColor, `${what} is a list of '#rrggbb' colors`).min(1, `${what} needs at least 1 color`)
  .max(PIPELINE_LIMITS.palette, `${what} has at most ${PIPELINE_LIMITS.palette} colors`);
const PATTERNS = ["none", "bayer2", "bayer4", "checker"] as const;
const patternEnum = z.enum(PATTERNS, `dither must be one of ${PATTERNS.join(", ")}`);
const noiseSpec = z.object({
  kind: z.enum(NOISE_KINDS as [NoiseKind, ...NoiseKind[]], `noise kind must be one of ${NOISE_KINDS.join(", ")}`).optional(),
  scale: anim(0.5, 256, "noise scale").optional(),
  octaves: num(1, 6, "octaves", true).optional(),
  lacunarity: num(1, 4, "lacunarity").optional(),
  gain: num(0.1, 0.9, "gain").optional(),
  seed: z.number().int("seed is a whole number").optional(),
}).strict();
export type NoiseSpec = z.infer<typeof noiseSpec>;

// ---------------------------------------------------------------------------
// The step registry
// ---------------------------------------------------------------------------

/** What a step sees besides its buffer. */
export interface StepContext {
  /** Normalized time: i / (n - 1) for a one-shot, i / n (the loop phase) for a loop. */
  t: number;
  /** 0-based frame index and frame count. */
  index: number;
  frames: number;
  loop: boolean;
  /** The step's seed (the pipeline's seed and the step's index). */
  seed: number;
  /** The working palette sorted dark to bright (OKLab L): palette steps index it. */
  ramp: RGBA[];
  /** Every color the result may use (the final snap's palette). */
  allowed: RGBA[];
  /** This frame's source image (before any step). */
  source: Rgba;
  /** A seeded noise source (cached per seed). */
  noise(seed: number): Noise;
  /** A color reference (palette step or hex) as a color. */
  color(ref: number | string): RGBA;
}

export interface StepDef {
  type: string;
  /** One line for the tool description. */
  what: string;
  /** The step's params (without `type`), strict. */
  schema: z.ZodObject<any>;
  /** One frame: params with animations already evaluated at ctx.t. Return a new image (or the input changed in place). */
  run(img: Rgba, params: any, ctx: StepContext): Rgba;
}

/** Step types by name, in the order the tool lists them. smear (#105) and fluid (#106) register here too. */
export const STEP_TYPES = new Map<string, StepDef>();

export function registerStep(def: StepDef): void {
  STEP_TYPES.set(def.type, def);
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

const copy = (img: Rgba): Rgba => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });
const opaqueAt = (img: Rgba, i: number) => img.data[i * 4 + 3] >= OPAQUE;
const rgbaAt = (img: Rgba, i: number): RGBA => ({ r: img.data[i * 4], g: img.data[i * 4 + 1], b: img.data[i * 4 + 2], a: 255 });
const put = (img: Rgba, i: number, c: RGBA) => { img.data[i * 4] = c.r; img.data[i * 4 + 1] = c.g; img.data[i * 4 + 2] = c.b; img.data[i * 4 + 3] = 255; };
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]], N8 = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];

/**
 * Grid distance (4- or 8-connected steps) from every pixel to the nearest seed, and which seed that is (its pixel
 * index; -1 when the nearest is outside the canvas). `edge`: the canvas border counts as a seed one step outside.
 */
export function gridDistance(w: number, h: number, seed: (i: number) => boolean, conn: 4 | 8, edge = false): { d: Int32Array; from: Int32Array } {
  const d = new Int32Array(w * h).fill(-1), from = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (let i = 0; i < w * h; i++) if (seed(i)) { d[i] = 0; from[i] = i; queue[tail++] = i; }
  if (edge) {
    // Border pixels are one step from the outside (in 8-connectivity, every border pixel is).
    for (let i = 0; i < w * h; i++) {
      if (d[i] === 0) continue;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { d[i] = 1; from[i] = -1; }
    }
    for (let i = 0; i < w * h; i++) if (d[i] === 1) queue[tail++] = i;
  }
  const nb = conn === 8 ? N8 : N4;
  while (head < tail) {
    const i = queue[head++], x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of nb) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (d[j] >= 0) continue;
      d[j] = d[i] + 1; from[j] = from[i];
      queue[tail++] = j;
    }
  }
  return { d, from };
}

/** Exact Euclidean distance to the nearest seed pixel (Felzenszwalb & Huttenlocher's 1D lower envelopes). */
export function euclideanDistance(w: number, h: number, seed: (i: number) => boolean): Float64Array {
  const INF = 1e12, f = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = seed(i) ? 0 : INF;
  const pass = (len: number, get: (k: number) => number, set: (k: number, v: number) => void) => {
    const v = new Int32Array(len), zz = new Float64Array(len + 1), g = new Float64Array(len);
    for (let k = 0; k < len; k++) g[k] = get(k);
    let k = 0;
    v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= zz[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; zz[k] = s; zz[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (zz[k + 1] < q) k++;
      set(q, (q - v[k]) ** 2 + g[v[k]]);
    }
  };
  for (let x = 0; x < w; x++) pass(h, (y) => f[y * w + x], (y, val) => { f[y * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (x) => f[y * w + x], (x, val) => { f[y * w + x] = val; });
  for (let i = 0; i < w * h; i++) f[i] = Math.sqrt(f[i]);
  return f;
}

const L = (c: RGBA) => toOklab(c).L;
/** The nearest palette color that is clearly lighter (darker with dir -1); the color itself when there is none. */
export function paletteStep(c: RGBA, ramp: RGBA[], dir: 1 | -1 = 1): RGBA {
  const l = L(c);
  const pool = ramp.filter((p) => (dir > 0 ? L(p) > l + 0.03 : L(p) < l - 0.03));
  return pool.length ? nearest(c, pool).color : c;
}

/** Value in [0, 1) of a noise spec at pixel (x, y) and time. */
function noise01(ctx: StepContext, spec: NoiseSpec | undefined, x: number, y: number, speed: number, defaults: { kind: NoiseKind; scale: number }): number {
  const n = ctx.noise(spec?.seed ?? ctx.seed);
  const v = field(n, spec?.kind ?? defaults.kind, x + 0.5, y + 0.5, (spec?.scale as number | undefined) ?? defaults.scale,
    { t: ctx.t, loop: ctx.loop, speed }, { octaves: spec?.octaves, lacunarity: spec?.lacunarity, gain: spec?.gain });
  return Math.min(0.999999, Math.max(0, (v + 1) / 2));
}

const pattern = (p: string | undefined): Pattern | undefined => (p && p !== "none" ? (p as Pattern) : undefined);

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

registerStep({
  type: "outline",
  what: "outline: outer (around the shape) or inner (its edge pixels), color (palette step, '#hex', 'darkest' or 'selout': a darker shade of the color it borders), thickness 1-8, neighbors 4 or 8",
  schema: z.object({
    mode: z.enum(["outer", "inner"], "mode must be 'outer' or 'inner'").optional(),
    color: colorRef("color", ["darkest", "selout"]).optional(),
    thickness: anim(0, 8, "thickness").optional(),
    neighbors: z.union([z.literal(4), z.literal(8)], { error: "neighbors must be 4 or 8" }).optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, k = Math.round(p.thickness ?? 1), inner = p.mode === "inner";
    if (k <= 0) return img;
    const conn = p.neighbors ?? 4, out = copy(img);
    const ref = p.color ?? (inner ? "selout" : "darkest");
    const fixed = ref === "selout" ? undefined : ref === "darkest" ? ctx.ramp[0] : ctx.color(ref);
    const { d, from } = inner
      ? gridDistance(w, h, (i) => !opaqueAt(img, i), conn, true)
      : gridDistance(w, h, (i) => opaqueAt(img, i), conn);
    for (let i = 0; i < w * h; i++) {
      if (inner !== opaqueAt(img, i) || d[i] < 1 || d[i] > k) continue;
      // selout: a darker shade of the shape's own color (the bordering pixel outside, this pixel inside).
      const c = fixed ?? darker(rgbaAt(img, inner ? i : from[i]), ctx.ramp);
      put(out, i, c);
    }
    return out;
  },
});

registerStep({
  type: "dissolve",
  what: "dissolve: pixels vanish where noise is below threshold (the fraction gone, default 0 to 1 over the effect), with an edge band (width as a fraction) in edge_color (default 'lighter': one palette step lighter)",
  schema: z.object({
    threshold: anim(0, 1, "threshold").optional(),
    edge: anim(0, 0.5, "edge").optional(),
    edge_color: colorRef("edge_color", ["lighter", "darker"]).optional(),
    noise: noiseSpec.optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, out = copy(img);
    const th = p.threshold ?? ctx.t, edge = p.edge ?? 0.08, ec = p.edge_color ?? "lighter";
    // Rank the noise over the opaque pixels, so threshold is the fraction gone whatever the noise's spread.
    const idx: number[] = [], val: number[] = [];
    for (let i = 0; i < w * h; i++) if (opaqueAt(img, i)) { idx.push(i); val.push(noise01(ctx, p.noise, i % w, (i / w) | 0, 0, { kind: "value", scale: 3 })); }
    const order = idx.map((_, k) => k).sort((a, b) => val[a] - val[b] || idx[a] - idx[b]);
    const rank = new Float64Array(idx.length);
    order.forEach((k, r) => { rank[k] = (r + 0.5) / idx.length; });
    idx.forEach((i, k) => {
      const v = rank[k];
      if (v < th) { out.data.fill(0, i * 4, i * 4 + 4); return; }
      if (th > 0 && v < th + edge) {
        const own = rgbaAt(img, i);
        put(out, i, ec === "lighter" ? paletteStep(own, ctx.ramp, 1) : ec === "darker" ? paletteStep(own, ctx.ramp, -1) : ctx.color(ec));
      }
    });
    return out;
  },
});

registerStep({
  type: "displace",
  what: "displace: move pixels by noise (mode 'noise': scale px, noise kind) or a sine wave (mode 'wave': wavelength px), amount px, axis x/y/both, speed (how far it travels over the effect; loops wrap); nearest sampling, no new colors",
  schema: z.object({
    mode: z.enum(["noise", "wave"], "mode must be 'noise' or 'wave'").optional(),
    amount: anim(0, 64, "amount").optional(),
    axis: z.enum(["x", "y", "both"], "axis must be 'x', 'y' or 'both'").optional(),
    wavelength: anim(2, 256, "wavelength").optional(),
    speed: anim(0, 16, "speed").optional(),
    noise: noiseSpec.optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, out = blank(w, h);
    const amount = p.amount ?? 2, wave = p.mode === "wave", axis = p.axis ?? (wave ? "x" : "both"), speed = p.speed ?? 1;
    const wl = p.wavelength ?? 8;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let dx = 0, dy = 0;
      if (wave) {
        const ph = 2 * Math.PI * speed * ctx.t;
        if (axis !== "y") dx = amount * Math.sin(2 * Math.PI * y / wl + ph);
        if (axis !== "x") dy = amount * Math.sin(2 * Math.PI * x / wl + ph);
      } else {
        const sp = { ...p.noise, seed: p.noise?.seed ?? ctx.seed };
        if (axis !== "y") dx = amount * (noise01(ctx, sp, x, y, speed, { kind: "simplex", scale: 8 }) * 2 - 1);
        if (axis !== "x") dy = amount * (noise01(ctx, { ...sp, seed: sp.seed + 977 }, x, y, speed, { kind: "simplex", scale: 8 }) * 2 - 1);
      }
      const sx = x - Math.round(dx), sy = y - Math.round(dy);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = (sy * w + sx) * 4;
      if (img.data[i + 3]) out.data.set(img.data.subarray(i, i + 4), (y * w + x) * 4);
    }
    return out;
  },
});

registerStep({
  type: "gradient_map",
  what: "gradient_map: each pixel's lightness (OKLab L, stretched over the frame's range unless normalize is false) picks a ramp color (default the palette, dark to bright), shift moves along it, optional ordered dither",
  schema: z.object({
    ramp: ramp("ramp").optional(),
    normalize: z.boolean().optional(),
    shift: anim(-1, 1, "shift").optional(),
    dither: patternEnum.optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, out = copy(img);
    const colors = p.ramp ? (p.ramp as string[]).map((c) => parseHex(c)!) : ctx.ramp;
    const ls = new Float64Array(w * h);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < w * h; i++) {
      if (!opaqueAt(img, i)) continue;
      ls[i] = L(rgbaAt(img, i));
      lo = Math.min(lo, ls[i]); hi = Math.max(hi, ls[i]);
    }
    const norm = p.normalize !== false && hi > lo, pat = pattern(p.dither), shift = p.shift ?? 0, n = colors.length;
    for (let i = 0; i < w * h; i++) {
      if (!opaqueAt(img, i)) continue;
      const v = Math.min(1, Math.max(0, (norm ? (ls[i] - lo) / (hi - lo) : ls[i]) + shift));
      let k: number;
      if (pat && n > 1) {
        const pos = v * (n - 1), f = Math.floor(pos);
        k = Math.min(n - 1, pos - f > threshold(pat, i % w, (i / w) | 0) ? f + 1 : f);
      } else k = Math.round(v * (n - 1));
      put(out, i, colors[k]);
    }
    return out;
  },
});

registerStep({
  type: "glow",
  what: "glow: the shape's mask grown by radius px (round, Euclidean) and filled by distance with a ramp (inner to outer; default color then darker palette steps), behind the shape; no blur",
  schema: z.object({
    radius: anim(0, 32, "radius").optional(),
    color: colorRef("color").optional(),
    ramp: ramp("ramp").optional(),
    levels: num(1, 8, "levels", true).optional(),
    dither: patternEnum.optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, r = p.radius ?? 3;
    if (r <= 0) return img;
    let colors: RGBA[];
    if (p.ramp) colors = (p.ramp as string[]).map((c) => parseHex(c)!);
    else {
      colors = [ctx.color(p.color ?? -1)];
      const levels = p.levels ?? Math.min(3, Math.max(1, Math.round(r)));
      while (colors.length < levels) {
        const next = paletteStep(colors[colors.length - 1], ctx.ramp, -1);
        if (hex(next) === hex(colors[colors.length - 1])) break;
        colors.push(next);
      }
    }
    const d = euclideanDistance(w, h, (i) => opaqueAt(img, i)), out = copy(img), pat = pattern(p.dither), n = colors.length;
    for (let i = 0; i < w * h; i++) {
      if (opaqueAt(img, i) || d[i] > r + 0.5) continue;
      const pos = Math.max(0, (d[i] - 1) / Math.max(1, r)) * n;
      let k = Math.min(n - 1, Math.floor(pos));
      if (pat && k < n - 1 && pos - k > threshold(pat, i % w, (i / w) | 0)) k++;
      if (pat && k === n - 1 && pos - k > threshold(pat, i % w, (i / w) | 0) && d[i] > r - 0.5) continue;
      put(out, i, colors[k]);
    }
    return out;
  },
});

registerStep({
  type: "noise_fill",
  what: "noise_fill: fill the shape (target 'mask') or the whole canvas ('canvas') with noise quantized to a ramp (default the palette) in levels; below cutoff stays (mask) or is empty (canvas); speed moves it (loops wrap); optional dither",
  schema: z.object({
    target: z.enum(["mask", "canvas"], "target must be 'mask' or 'canvas'").optional(),
    noise: noiseSpec.optional(),
    ramp: ramp("ramp").optional(),
    levels: num(1, 16, "levels", true).optional(),
    cutoff: anim(0, 1, "cutoff").optional(),
    speed: anim(0, 16, "speed").optional(),
    dither: patternEnum.optional(),
  }).strict(),
  run(img, p, ctx) {
    const { width: w, height: h } = img, out = copy(img);
    let colors = p.ramp ? (p.ramp as string[]).map((c) => parseHex(c)!) : ctx.ramp;
    if (p.levels && p.levels < colors.length) {
      const src = colors;
      colors = Array.from({ length: p.levels }, (_, k) => src[p.levels === 1 ? src.length - 1 : Math.round((k * (src.length - 1)) / (p.levels - 1))]);
    }
    const target = p.target ?? (bounds(img) ? "mask" : "canvas"), cut = p.cutoff ?? 0, speed = p.speed ?? 1;
    const pat = pattern(p.dither), n = colors.length;
    for (let i = 0; i < w * h; i++) {
      if (target === "mask" && !opaqueAt(img, i)) continue;
      const x = i % w, y = (i / w) | 0, v = noise01(ctx, p.noise, x, y, speed, { kind: "simplex", scale: 8 });
      if (v < cut) { if (target === "canvas") out.data.fill(0, i * 4, i * 4 + 4); continue; }
      const u = cut < 1 ? (v - cut) / (1 - cut) : 0, pos = u * (n - 1);
      let k = pat ? Math.floor(pos) : Math.round(pos);
      if (pat && k < n - 1 && pos - k > threshold(pat, x, y)) k++;
      put(out, i, colors[Math.min(n - 1, k)]);
    }
    return out;
  },
});

registerStep({
  type: "palette_map",
  what: "palette_map: every pixel to the nearest color in OKLab of colors (default the palette), optionally ordered-dithered between the two nearest (bayer2, bayer4, checker) with strength",
  schema: z.object({
    colors: ramp("colors").optional(),
    dither: patternEnum.optional(),
    strength: anim(0, 1, "strength").optional(),
  }).strict(),
  run(img, p, ctx) {
    const colors = p.colors ? (p.colors as string[]).map((c) => parseHex(c)!) : ctx.ramp;
    const pat = pattern(p.dither);
    if (pat) return ditherToPalette(img, colors, pat, p.strength ?? 1);
    const out = copy(img), memo = new Map<number, RGBA>();
    for (let i = 0; i < img.width * img.height; i++) {
      if (!opaqueAt(img, i)) continue;
      const key = (img.data[i * 4] << 16) | (img.data[i * 4 + 1] << 8) | img.data[i * 4 + 2];
      let c = memo.get(key);
      if (!c) memo.set(key, (c = nearest(rgbaAt(img, i), colors).color));
      put(out, i, c);
    }
    return out;
  },
});

registerStep({
  type: "juice",
  what: `juice: one juice effect (${JUICE_EFFECTS.join(", ")}) across the pipeline's frames, with the juice tool's options (amount, px, cycles, damping, bounces, turns, ease, pivot, color for flash); pixel-safe warps`,
  schema: z.object({
    effect: z.enum(JUICE_EFFECTS as [JuiceEffect, ...JuiceEffect[]], `effect must be one of ${JUICE_EFFECTS.join(", ")}`),
    amount: anim(0, 2, "amount").optional(),
    px: anim(1, 256, "px").optional(),
    cycles: anim(0.25, 8, "cycles").optional(),
    damping: anim(0, 2, "damping").optional(),
    bounces: num(0, 6, "bounces", true).optional(),
    turns: anim(-8, 8, "turns").optional(),
    ease: easeEnum.optional(),
    pivot: z.enum(["bottom", "center", "top"], "pivot must be 'bottom', 'center' or 'top'").optional(),
    color: colorRef("color").optional(),
  }).strict(),
  run(img, p, ctx) {
    const pivotAt = p.pivot ?? (["shake", "flash", "pulse", "spin"].includes(p.effect) ? "center" : "bottom");
    // The pivot and box come from the frame's source, so steps before this one do not move them.
    const { pivot, box } = pivotOf(ctx.source, pivotAt);
    if (!box) return img;
    const step = juicePlan(p.effect, ctx.frames, box, {
      amount: p.amount, px: p.px === undefined ? undefined : Math.round(p.px), cycles: p.cycles, damping: p.damping,
      bounces: p.bounces, turns: p.turns, ease: p.ease, seed: ctx.seed,
    })[ctx.index];
    const wp = step.warp;
    const needsBig = wp.rot || wp.wave || wp.kx || (wp.sx ?? 1) !== 1 || (wp.sy ?? 1) !== 1;
    const moved = warp(img, wp, pivot, needsBig ? upscale8(img) : undefined);
    return step.flash ? flashImage(moved, ctx.color(p.color ?? "#ffffff")) : moved;
  },
});

registerStep({
  type: "flash",
  what: "flash: opaque pixels turned to color (default #ffffff); amount 0..1 flashes that fraction of them in an ordered (Bayer) pattern; every k flashes only every k-th frame",
  schema: z.object({
    color: colorRef("color").optional(),
    amount: anim(0, 1, "amount").optional(),
    every: num(1, 8, "every", true).optional(),
  }).strict(),
  run(img, p, ctx) {
    const amount = p.amount ?? 1;
    if (amount <= 0 || ctx.index % (p.every ?? 1) !== 0) return img;
    const c = ctx.color(p.color ?? "#ffffff"), out = copy(img), w = img.width;
    for (let i = 0; i < img.width * img.height; i++) {
      if (opaqueAt(img, i) && amount > threshold("bayer4", i % w, (i / w) | 0)) put(out, i, c);
    }
    return out;
  },
});

registerStep({
  type: "tint",
  what: "tint: every pixel moved toward color by amount in OKLab, then snapped to the allowed colors (optionally ordered-dithered)",
  schema: z.object({
    color: colorRef("color"),
    amount: anim(0, 1, "amount").optional(),
    dither: patternEnum.optional(),
  }).strict(),
  run(img, p, ctx) {
    const amount = p.amount ?? 0.5;
    if (amount <= 0) return img;
    const c = toOklab(ctx.color(p.color)), out = copy(img);
    for (let i = 0; i < img.width * img.height; i++) {
      if (!opaqueAt(img, i)) continue;
      const o = toOklab(rgbaAt(img, i));
      put(out, i, fromOklab({ L: o.L + (c.L - o.L) * amount, a: o.a + (c.a - o.a) * amount, b: o.b + (c.b - o.b) * amount }));
    }
    const pat = pattern(p.dither);
    return pat ? ditherToPalette(out, ctx.allowed, pat) : out;
  },
});

registerStep({
  type: "offset",
  what: "offset: move the image by whole pixels x, y (animatable), wrapping around the canvas when wrap is true",
  schema: z.object({
    x: anim(-256, 256, "x").optional(),
    y: anim(-256, 256, "y").optional(),
    wrap: z.boolean().optional(),
  }).strict(),
  run(img, p) {
    const { width: w, height: h } = img, ox = Math.round(p.x ?? 0), oy = Math.round(p.y ?? 0), out = blank(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sx = x - ox, sy = y - oy;
      if (p.wrap) { sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h; }
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = (sy * w + sx) * 4;
      if (img.data[i + 3]) out.data.set(img.data.subarray(i, i + 4), (y * w + x) * 4);
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// The pipeline schema
// ---------------------------------------------------------------------------

const whole = (min: number, max: number, what: string) => num(min, max, what, true);
const layerSource = z.object({
  layer: z.string().min(1, "layer is a layer id or name").optional(),
  frame: whole(1, 9999, "frame").optional(),
}).strict();
const canvasSource = z.object({
  w: whole(1, PIPELINE_LIMITS.size, "w"), h: whole(1, PIPELINE_LIMITS.size, "h"),
  x: whole(-4096, 4096, "x").optional(), y: whole(-4096, 4096, "y").optional(),
  frame: whole(1, 9999, "frame").optional(),
}).strict();
const framesSpecSchema = z.union([z.string(), z.number().int(), z.array(z.number().int())], { error: "over is a frame (3), a list ([1, 2]), a range ('1-4') or 'all'" });

const stepSchema = dispatch((v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "a step is an object { type, ...params }";
  const type = (v as { type?: unknown }).type;
  const def = typeof type === "string" ? STEP_TYPES.get(type) : undefined;
  if (!def) {
    const msg = `type must be one of ${[...STEP_TYPES.keys()].join(", ")}`;
    return z.object({ type: z.never(msg) }).passthrough();
  }
  return def.schema.extend({ type: z.literal(def.type) });
});

export const pipelineSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "name is 1-40 lowercase letters, digits and dashes, e.g. 'burn-away'"),
  description: z.string().max(200, "description is at most 200 characters").optional(),
  source: dispatch((v) => typeof v === "string" ? z.string().min(1) : v && typeof v === "object" && !Array.isArray(v) && ("w" in v || "h" in v) ? canvasSource
    : v && typeof v === "object" && !Array.isArray(v) ? layerSource : "source is a layer name, { layer?, frame? } or a blank canvas { w, h, x?, y?, frame? }").optional(),
  frames: dispatch((v) => typeof v === "number" ? whole(1, PIPELINE_LIMITS.frames, "frames")
    : v && typeof v === "object" && !Array.isArray(v) ? z.object({ over: framesSpecSchema }).strict()
    : "frames is a count (1-48) or { over: frames } (3, [1, 2], '1-4', 'all')").optional(),
  fps: num(1, 60, "fps").optional(),
  loop: z.boolean().optional(),
  seed: z.number().int("seed is a whole number").optional(),
  palette: ramp("palette").optional(),
  steps: z.array(stepSchema).min(1, "a pipeline needs at least one step").max(PIPELINE_LIMITS.steps, `at most ${PIPELINE_LIMITS.steps} steps`),
}).strict();

export interface Pipeline {
  name: string;
  description?: string;
  source?: string | { layer?: string; frame?: number } | { w: number; h: number; x?: number; y?: number; frame?: number };
  frames?: number | { over: string | number | number[] };
  fps?: number;
  loop?: boolean;
  seed?: number;
  palette?: string[];
  steps: ({ type: string } & Record<string, unknown>)[];
}

function formatIssues(err: z.ZodError): string {
  return err.issues.slice(0, 12).map((i) => `- ${i.path.map(String).join(".") || "pipeline"}: ${i.message}`).join("\n") +
    (err.issues.length > 12 ? `\n- … ${err.issues.length - 12} more` : "");
}

/** A pipeline from JSON text or an object; throws an Error listing every problem by path. */
export function parsePipeline(input: unknown): Pipeline {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch (e) { throw new Error(`The pipeline is not valid JSON: ${(e as Error).message}`); }
  }
  const r = pipelineSchema.safeParse(value);
  if (!r.success) throw new Error(`The pipeline has problems:\n${formatIssues(r.error)}`);
  return r.data as Pipeline;
}

/** The blank-canvas source, when the pipeline has one. */
export function canvasOf(p: Pipeline): { w: number; h: number; x?: number; y?: number; frame?: number } | undefined {
  return p.source && typeof p.source === "object" && "w" in p.source ? p.source : undefined;
}

// ---------------------------------------------------------------------------
// Running a pipeline
// ---------------------------------------------------------------------------

/** Hex colors a pipeline names (its palette, step colors and ramps). */
export function pipelineColors(p: Pipeline): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.startsWith("#")) out.add(hex(parseHex(v)!)); };
  for (const c of p.palette ?? []) add(c);
  for (const s of p.steps) {
    for (const [k, v] of Object.entries(s)) {
      if (k === "type") continue;
      if (Array.isArray(v)) v.forEach(add); else add(v);
    }
    // The juice step's flash and the flash step default to white.
    if ((s.type === "flash" || (s.type === "juice" && s.effect === "flash")) && s.color === undefined) out.add("#ffffff");
  }
  return [...out];
}

export interface PipelineResult {
  frames: Rgba[];
  /** Colors the frames use that the sprite palette lacks (to append). */
  added: string[];
}

/** Normalized time of frame i of n. */
export const timeOf = (i: number, n: number, loop: boolean) => (loop ? i / n : n === 1 ? 1 : i / (n - 1));

/**
 * Runs a pipeline over one source image per output frame (layer frames, or blank canvases). `palette` is the
 * sprite palette (the working palette when the pipeline gives none). Pure and deterministic.
 */
export function runPipeline(p: Pipeline, sources: Rgba[], palette: RGBA[] = []): PipelineResult {
  const n = sources.length, loop = !!p.loop, seed = p.seed ?? 1;
  const own = new Map<string, RGBA>();
  for (const s of sources) for (let i = 0; i < s.width * s.height; i++) if (opaqueAt(s, i)) { const c = rgbaAt(s, i); own.set(hex(c), c); }
  const named = pipelineColors(p).map((h) => parseHex(h)!);
  const base = p.palette ? p.palette.map((c) => parseHex(c)!) : palette.filter((c) => c.a > 0);
  const work = dedupe(base.length ? base : [...own.values()].length ? [...own.values()] : [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }]);
  const ramp = work.slice().sort((a, b) => L(a) - L(b));
  const allowed = dedupe([...work, ...named, ...own.values()]);
  const noises = new Map<number, Noise>();
  const noise = (s: number) => { let x = noises.get(s); if (!x) noises.set(s, (x = new Noise(s))); return x; };
  const color = (ref: number | string): RGBA => typeof ref === "number"
    ? ramp[Math.max(0, Math.min(ramp.length - 1, ref < 0 ? ramp.length + ref : ref))]
    : parseHex(ref) ?? ramp[ramp.length - 1];

  const frames = sources.map((src, index) => {
    const t = timeOf(index, n, loop);
    let img: Rgba = copy(src);
    p.steps.forEach((s, k) => {
      const def = STEP_TYPES.get(s.type);
      if (!def) throw new Error(`Unknown step type ${s.type}.`);
      const { type: _type, ...params } = s;
      const ctx: StepContext = { t, index, frames: n, loop, seed: seed + k * 7919, ramp, allowed, source: src, noise, color };
      img = def.run(img, paramsAt(params, t), ctx);
    });
    return snap(img, allowed);
  });
  const have = new Set(palette.map(hex));
  const used = new Set<string>();
  for (const f of frames) for (let i = 0; i < f.width * f.height; i++) if (f.data[i * 4 + 3]) used.add(hex(rgbaAt(f, i)));
  const added = [...used].filter((h) => !have.has(h) && !own.has(h));
  return { frames, added };
}

function dedupe(colors: RGBA[]): RGBA[] {
  const seen = new Map<string, RGBA>();
  for (const c of colors) seen.set(hex(c), { r: c.r, g: c.g, b: c.b, a: 255 });
  return [...seen.values()];
}

/** Every opaque pixel to its nearest allowed color (OKLab), alpha to 0 or 255. */
function snap(img: Rgba, allowed: RGBA[]): Rgba {
  const out = copy(img), memo = new Map<number, RGBA>(), keys = new Set(allowed.map(hex));
  for (let i = 0; i < img.width * img.height; i++) {
    if (!opaqueAt(img, i)) { out.data.fill(0, i * 4, i * 4 + 4); continue; }
    const c = rgbaAt(img, i);
    if (keys.has(hex(c))) { out.data[i * 4 + 3] = 255; continue; }
    const key = (c.r << 16) | (c.g << 8) | c.b;
    let m = memo.get(key);
    if (!m) memo.set(key, (m = nearest(c, allowed).color));
    put(out, i, m);
  }
  return out;
}
