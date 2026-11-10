// Color science for the palette and tone skills (#36, #38): OKLab,
// quantization, ramps, palette matching, remapping and tone statistics.
// Pure functions over color lists; pixel I/O lives in the extension.

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A color with how many pixels use it. */
export interface Counted extends RGBA {
  count: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export function hex(c: RGBA): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 255 ? h(c.a) : ""}`;
}

export function parseHex(s: string): RGBA | undefined {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s.trim());
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
}

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

export function toOklab({ r, g, b }: RGBA): Lab {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function fromOklab({ L, a, b }: Lab, alpha = 255): RGBA {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

/** OKLCH: lightness, chroma, hue in degrees. */
export function toOklch(c: RGBA): { L: number; C: number; h: number } {
  const { L, a, b } = toOklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

export function fromOklch(L: number, C: number, h: number, alpha = 255): RGBA {
  const r = (h * Math.PI) / 180;
  return fromOklab({ L, a: C * Math.cos(r), b: C * Math.sin(r) }, alpha);
}

/** Perceptual distance (OKLab Euclidean; ~0.02 is barely visible). */
export function distance(x: RGBA, y: RGBA): number {
  const p = toOklab(x), q = toOklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

// ---------------------------------------------------------------------------
// Quantization
// ---------------------------------------------------------------------------

/** Merges equal colors and drops transparent ones (alpha below `minAlpha`). */
export function tally(colors: Counted[], minAlpha = 128): Counted[] {
  const map = new Map<string, Counted>();
  for (const c of colors) {
    if (c.a < minAlpha) continue;
    const key = hex({ ...c, a: 255 });
    const e = map.get(key);
    if (e) e.count += c.count;
    else map.set(key, { r: c.r, g: c.g, b: c.b, a: 255, count: c.count });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function weightedMean(group: { lab: Lab; count: number }[]): Lab {
  let n = 0, L = 0, a = 0, b = 0;
  for (const g of group) {
    n += g.count;
    L += g.lab.L * g.count;
    a += g.lab.a * g.count;
    b += g.lab.b * g.count;
  }
  return { L: L / n, a: a / n, b: b / n };
}

/** Median cut in OKLab, weighted by pixel count. */
export function medianCut(colors: Counted[], k: number): Counted[] {
  const items = colors.map((c) => ({ lab: toOklab(c), count: c.count }));
  let boxes = [items];
  while (boxes.length < k) {
    // Split the box with the largest weighted spread.
    let best = -1, bestAxis: keyof Lab = "L", bestSpread = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (const axis of ["L", "a", "b"] as (keyof Lab)[]) {
        const vals = box.map((x) => x.lab[axis]);
        const spread = (Math.max(...vals) - Math.min(...vals)) * Math.sqrt(box.reduce((s, x) => s + x.count, 0));
        if (spread > bestSpread) {
          bestSpread = spread;
          best = i;
          bestAxis = axis;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best].slice().sort((x, y) => x.lab[bestAxis] - y.lab[bestAxis]);
    const total = box.reduce((s, x) => s + x.count, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].count;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => ({ ...fromOklab(weightedMean(box)), count: box.reduce((s, x) => s + x.count, 0) }));
}

/** K-means in OKLab, seeded with median cut, weighted by pixel count. */
export function kMeans(colors: Counted[], k: number, iterations = 12): Counted[] {
  const items = colors.map((c) => ({ lab: toOklab(c), count: c.count }));
  let centers = medianCut(colors, k).map(toOklab);
  let groups: { lab: Lab; count: number }[][] = [];
  for (let it = 0; it < iterations; it++) {
    groups = centers.map(() => []);
    for (const x of items) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => {
        const d = (c.L - x.lab.L) ** 2 + (c.a - x.lab.a) ** 2 + (c.b - x.lab.b) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      groups[bi].push(x);
    }
    centers = groups.map((g, i) => (g.length ? weightedMean(g) : centers[i]));
  }
  return groups
    .map((g, i) => ({ ...fromOklab(centers[i]), count: g.reduce((s, x) => s + x.count, 0) }))
    .filter((c) => c.count > 0);
}

/** Reduces to at most `k` colors; exact when there are already few enough. */
export function quantize(colors: Counted[], k: number, method: "exact" | "median-cut" | "k-means" = "k-means"): Counted[] {
  const t = tally(colors, 0);
  if (method === "exact" || t.length <= k) return t;
  return tally(method === "median-cut" ? medianCut(t, k) : kMeans(t, k), 0);
}

// ---------------------------------------------------------------------------
// Ramps, duplicates, matching
// ---------------------------------------------------------------------------

export const NEUTRAL_CHROMA = 0.03;

/**
 * Groups colors into ramps: neutrals (low chroma) together, chromatic
 * colors by hue (a new ramp where the hue jumps more than `gap` degrees),
 * each ramp ordered dark to light.
 */
export function ramps(colors: RGBA[], gap = 35): { name: string; colors: RGBA[] }[] {
  const lch = colors.map((c) => ({ c, ...toOklch(c) }));
  const neutral = lch.filter((x) => x.C < NEUTRAL_CHROMA);
  const chroma = lch.filter((x) => x.C >= NEUTRAL_CHROMA).sort((a, b) => a.h - b.h);
  const groups: (typeof lch)[] = [];
  for (const x of chroma) {
    const g = groups.at(-1);
    if (g && x.h - g.at(-1)!.h <= gap) g.push(x);
    else groups.push([x]);
  }
  // Hue wraps around: join the last and first groups when they are close.
  if (groups.length > 1 && groups[0][0].h + 360 - groups.at(-1)!.at(-1)!.h <= gap) {
    groups[0] = [...groups.pop()!, ...groups[0]];
  }
  const out = groups.map((g) => ({ name: hueName(meanHue(g.map((x) => x.h))), colors: g.sort((a, b) => a.L - b.L).map((x) => x.c) }));
  if (neutral.length) out.push({ name: "neutral", colors: neutral.sort((a, b) => a.L - b.L).map((x) => x.c) });
  return out;
}

function meanHue(hs: number[]): number {
  const x = hs.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0);
  const y = hs.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0);
  const h = (Math.atan2(y, x) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/** A rough name for an OKLCH hue. */
export function hueName(h: number): string {
  const names: [number, string][] = [
    [20, "pink"], [45, "red"], [70, "orange"], [100, "yellow"], [140, "lime"], [175, "green"],
    [210, "teal"], [250, "cyan"], [285, "blue"], [320, "purple"], [345, "magenta"], [360, "pink"],
  ];
  return names.find(([max]) => h < max)?.[1] ?? "pink";
}

/** Pairs of colors closer than `threshold` (likely unintended duplicates). */
export function nearDuplicates(colors: RGBA[], threshold = 0.025): [RGBA, RGBA, number][] {
  const out: [RGBA, RGBA, number][] = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = distance(colors[i], colors[j]);
      if (d < threshold) out.push([colors[i], colors[j], d]);
    }
  }
  return out;
}

export function nearest(c: RGBA, palette: RGBA[]): { color: RGBA; index: number; d: number } {
  let index = 0, d = Infinity;
  palette.forEach((p, i) => {
    const e = distance(c, p);
    if (e < d) {
      d = e;
      index = i;
    }
  });
  return { color: palette[index], index, d };
}

export interface PaletteMatch {
  name: string;
  size: number;
  /** Pixel-weighted mean distance to the nearest palette color. */
  error: number;
  /** Share of pixels within a barely visible distance (0..1). */
  coverage: number;
  score: number;
}

/**
 * Ranks palettes by how well they cover the colors, weighted by pixel
 * count, with a penalty for palettes much larger than needed (a 256-color
 * palette covers everything but says nothing).
 */
export function matchPalettes(colors: Counted[], palettes: { name: string; colors: RGBA[] }[], top = 5): PaletteMatch[] {
  const total = colors.reduce((s, c) => s + c.count, 0) || 1;
  const distinct = colors.length;
  return palettes
    .filter((p) => p.colors.length > 0)
    .map((p) => {
      let err = 0, covered = 0;
      for (const c of colors) {
        const { d } = nearest(c, p.colors);
        err += d * c.count;
        if (d < 0.03) covered += c.count;
      }
      const error = err / total;
      const oversize = Math.max(0, p.colors.length / Math.max(distinct, 1) - 2);
      return { name: p.name, size: p.colors.length, error, coverage: covered / total, score: error + 0.004 * oversize };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, top);
}

// ---------------------------------------------------------------------------
// Remapping and tone
// ---------------------------------------------------------------------------

/**
 * A color map from each source color to a palette color. With
 * `preserveRamps`, each source ramp (3+ colors) maps into the one target
 * ramp its colors mostly land in, keeping dark-to-light order, so shading
 * doesn't jump between hues; other colors use the nearest color.
 */
export function remap(source: RGBA[], palette: RGBA[], preserveRamps = true): Map<string, RGBA> {
  const map = new Map<string, RGBA>();
  for (const c of source) map.set(hex(c), { ...nearest(c, palette).color, a: c.a });
  if (!preserveRamps) return map;
  const targetRamps = ramps(palette);
  for (const r of ramps(source)) {
    if (r.colors.length < 3) continue;
    // The target ramp the nearest-color mapping uses most.
    const votes = new Map<number, number>();
    for (const c of r.colors) {
      const m = nearest(c, palette).color;
      const ti = targetRamps.findIndex((t) => t.colors.some((x) => hex(x) === hex(m)));
      if (ti >= 0) votes.set(ti, (votes.get(ti) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const target = targetRamps[best[0]].colors;
    if (target.length < 2) continue;
    // Nearest in the target ramp, then keep the dark-to-light order (a
    // lighter source color never maps darker than the one before it).
    let prev = 0;
    r.colors.forEach((c) => {
      let idx = nearest(c, target).index;
      if (idx < prev) idx = prev;
      prev = idx;
      map.set(hex(c), { ...target[idx], a: c.a });
    });
  }
  return map;
}

export interface ToneStats {
  colors: number;
  lightness: number; // mean OKLab L, pixel-weighted (0..1)
  chroma: number; // mean chroma
  contrast: number; // standard deviation of L
  warmth: number; // mean of cos(hue - 60°) weighted by chroma: + warm, - cool
  darkest: string;
  lightest: string;
}

export function toneStats(colors: Counted[]): ToneStats {
  const total = colors.reduce((s, c) => s + c.count, 0) || 1;
  let L = 0, C = 0, warm = 0, cw = 0;
  const lch = colors.map((c) => ({ c, ...toOklch(c) }));
  for (const x of lch) {
    L += x.L * x.c.count;
    C += x.C * x.c.count;
    warm += Math.cos(((x.h - 60) * Math.PI) / 180) * x.C * x.c.count;
    cw += x.C * x.c.count;
  }
  const meanL = L / total;
  const variance = lch.reduce((s, x) => s + (x.L - meanL) ** 2 * x.c.count, 0) / total;
  const sorted = lch.slice().sort((a, b) => a.L - b.L);
  return {
    colors: colors.length,
    lightness: meanL,
    chroma: C / total,
    contrast: Math.sqrt(variance),
    warmth: cw ? warm / cw : 0,
    darkest: sorted.length ? hex(sorted[0].c) : "",
    lightest: sorted.length ? hex(sorted.at(-1)!.c) : "",
  };
}

/** Plain-language differences between two tones (`a` compared with `b`). */
export function describeToneDifference(a: ToneStats, b: ToneStats): string[] {
  const out: string[] = [];
  const pct = (x: number, y: number) => Math.round(((x - y) / Math.max(y, 1e-6)) * 100);
  const dl = a.lightness - b.lightness;
  if (Math.abs(dl) > 0.03) out.push(`${dl > 0 ? "lighter" : "darker"} overall (L ${a.lightness.toFixed(2)} vs ${b.lightness.toFixed(2)})`);
  if (Math.abs(a.chroma - b.chroma) > 0.01) {
    const p = pct(a.chroma, b.chroma);
    out.push(`${Math.abs(p)}% ${p > 0 ? "more" : "less"} saturated`);
  }
  if (Math.abs(a.contrast - b.contrast) > 0.02) out.push(`${a.contrast > b.contrast ? "more" : "less"} contrast`);
  if (Math.abs(a.warmth - b.warmth) > 0.15) out.push(`${a.warmth > b.warmth ? "warmer" : "cooler"} colors`);
  if (a.colors > b.colors * 1.5 && a.colors - b.colors > 4) out.push(`many more colors (${a.colors} vs ${b.colors})`);
  return out;
}

/** Shifts a color's tone in OKLCH: lightness/chroma deltas, hue rotation, contrast around `pivot`. */
export function adjust(c: RGBA, o: { lightness?: number; chroma?: number; hue?: number; contrast?: number; pivot?: number }): RGBA {
  const x = toOklch(c);
  let L = x.L;
  if (o.contrast) L = (o.pivot ?? 0.5) + (L - (o.pivot ?? 0.5)) * (1 + o.contrast);
  L = Math.max(0, Math.min(1, L + (o.lightness ?? 0)));
  const C = Math.max(0, x.C * (1 + (o.chroma ?? 0)));
  return fromOklch(L, C, x.h + (o.hue ?? 0), c.a);
}

/** The adjustment that moves `from` stats towards `to` (fully at strength 1). */
export function toneTowards(from: ToneStats, to: ToneStats, strength = 1) {
  return {
    lightness: (to.lightness - from.lightness) * strength,
    chroma: from.chroma > 1e-6 ? (to.chroma / from.chroma - 1) * strength : 0,
    contrast: from.contrast > 1e-6 ? (to.contrast / from.contrast - 1) * strength : 0,
    pivot: from.lightness,
  };
}
