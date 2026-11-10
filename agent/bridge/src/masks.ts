// Emission and specular masks beside the normal map (#67).
import { distance, parseHex, toOklch, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

export interface EmissionOptions {
  /** These colors glow (hex). */
  colors?: string[];
  /** OKLab distance that still counts as the same color. Default 0.02. */
  tolerance?: number;
  /** A painted layer: its opaque pixels glow (and give the glow color with keepColor). */
  painted?: Rgba;
  /** Threshold pick when no colors or painted layer: OKLCH lightness at least this. Default 0.7. */
  minLightness?: number;
  /** And OKLCH chroma at least this. Default 0.1. */
  minChroma?: number;
  /** Write the glowing pixel's own color instead of white. */
  keepColor?: boolean;
}

export interface SpecularOptions {
  /** Only these colors are shiny (hex), e.g. a metal ramp. Others are 0. */
  colors?: string[];
  tolerance?: number;
  /** A flat shine (0..1) for the chosen pixels; otherwise it follows lightness. */
  value?: number;
  /** Per-color flat shine, by hex. Wins over value. */
  values?: Record<string, number>;
  /** Lightness where shine starts (from-lightness mode). Default 0.5. */
  minLightness?: number;
  /** Gray steps, 0 = smooth. Default 4 (0, 1/3, 2/3, 1). */
  levels?: number;
  /** A painted layer: its opaque pixels are shiny, by their gray value. */
  painted?: Rgba;
}

const px = (d: Uint8Array, i: number): RGBA => ({ r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] });

function matcher(hexes: string[] | undefined, tolerance = 0.02): ((c: RGBA) => number) | undefined {
  if (!hexes?.length) return undefined;
  const list = hexes.map((h) => {
    const c = parseHex(h);
    if (!c) throw new Error(`Not a hex color: ${h}`);
    return c;
  });
  // Index of the nearest listed color within tolerance, -1 when none.
  return (c) => {
    let best = -1, bd = Infinity;
    list.forEach((l, k) => {
      const d = l.r === c.r && l.g === c.g && l.b === c.b ? 0 : distance(l, c);
      if (d <= tolerance && d < bd) [best, bd] = [k, d];
    });
    return best;
  };
}

/** Quantizes 0..1 to `levels` evenly spaced steps (0 = untouched). */
export function quantizeLevel(v: number, levels: number): number {
  const c = Math.max(0, Math.min(1, v));
  return levels > 1 ? Math.round(c * (levels - 1)) / (levels - 1) : c;
}

/** Pixels that glow: white (or their color) on black inside the sprite, transparent outside. */
export function emissionMask(img: Rgba, o: EmissionOptions = {}): Rgba {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 4);
  const match = matcher(o.colors, o.tolerance);
  const minL = o.minLightness ?? 0.7, minC = o.minChroma ?? 0.1;
  for (let i = 0; i < w * h * 4; i += 4) {
    const c = px(data, i);
    const p = o.painted && o.painted.data[i + 3] >= 128 ? px(o.painted.data, i) : undefined;
    if (c.a < 128 && !p) continue;
    let glow: boolean;
    if (p) glow = true;
    else if (match) glow = match(c) >= 0;
    else if (o.painted) glow = false;
    else {
      const { L, C } = toOklch(c);
      glow = L >= minL && C >= minC;
    }
    const src = p ?? c;
    out.set(glow ? (o.keepColor ? [src.r, src.g, src.b, 255] : [255, 255, 255, 255]) : [0, 0, 0, 255], i);
  }
  return { width: w, height: h, data: out };
}

/** How shiny each pixel is, as quantized gray inside the sprite, transparent outside. */
export function specularMask(img: Rgba, o: SpecularOptions = {}): Rgba {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h * 4);
  const match = matcher(o.colors, o.tolerance);
  const perColor = o.colors?.map((hx) => o.values?.[hx] ?? o.values?.[hx.toLowerCase()] ?? o.value);
  const minL = o.minLightness ?? 0.5, levels = o.levels ?? 4;
  for (let i = 0; i < w * h * 4; i += 4) {
    const c = px(data, i);
    const p = o.painted && o.painted.data[i + 3] >= 128 ? px(o.painted.data, i) : undefined;
    if (c.a < 128 && !p) continue;
    let v: number;
    if (p) v = (p.r + p.g + p.b) / 765;
    else {
      const k = match ? match(c) : -2;
      if (k === -1) v = 0;
      else {
        const flat = k >= 0 ? perColor![k] : o.value;
        v = flat ?? (toOklch(c).L - minL) / (1 - minL);
      }
    }
    const g = Math.round(quantizeLevel(v, levels) * 255);
    out.set([g, g, g, 255], i);
  }
  return { width: w, height: h, data: out };
}
