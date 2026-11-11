// Motion curves for the sprite effects (#104): Robert Penner's easing equations (2001, BSD), a damped harmonic
// oscillator in closed form (as in Ryan Juckett's "Damped Springs", 2012), a decaying bounce and a deterministic
// shake. All take t in [0, 1] (the effect's normalized time) and are pure, so a frame's look depends only on t.

export type Ease =
  | "linear" | "in_quad" | "out_quad" | "in_out_quad" | "in_cubic" | "out_cubic" | "in_out_cubic"
  | "in_back" | "out_back" | "in_out_back" | "out_elastic" | "out_bounce";

export const EASES: Ease[] = ["linear", "in_quad", "out_quad", "in_out_quad", "in_cubic", "out_cubic", "in_out_cubic",
  "in_back", "out_back", "in_out_back", "out_elastic", "out_bounce"];

const BACK = 1.70158;

function outBounce(t: number): number {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** Penner's easing of t in [0, 1]; 0 maps to 0 and 1 to 1 (back and elastic overshoot in between). */
export function ease(name: Ease, t: number): number {
  t = Math.min(1, Math.max(0, t));
  switch (name) {
    case "linear": return t;
    case "in_quad": return t * t;
    case "out_quad": return t * (2 - t);
    case "in_out_quad": return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case "in_cubic": return t * t * t;
    case "out_cubic": return 1 + (t - 1) ** 3;
    case "in_out_cubic": return t < 0.5 ? 4 * t * t * t : 1 + 4 * (t - 1) ** 3;
    case "in_back": return t * t * ((BACK + 1) * t - BACK);
    case "out_back": return 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2;
    case "in_out_back": {
      const c = BACK * 1.525;
      return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
    }
    case "out_elastic":
      return t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    case "out_bounce": return outBounce(t);
  }
}

/**
 * A damped spring released from displacement 1 at rest: x(0) = 1, x'(0) = 0, settling to 0. `cycles` is how many
 * oscillations fit in t = 0..1 (the undamped frequency), `damping` the damping ratio ζ (0 < ζ < 1 rings, ≥ 1 settles
 * without overshoot). Closed form of the damped harmonic oscillator.
 */
export function spring(t: number, cycles = 2, damping = 0.3): number {
  const w = 2 * Math.PI * Math.max(0.01, cycles), z = Math.max(0, damping);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  }
  if (z === 1) return Math.exp(-w * t) * (1 + w * t);
  const r = Math.sqrt(z * z - 1), a = -w * (z - r), b = -w * (z + r);
  return (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a);
}

/**
 * Height of a ball dropped from 1 that bounces `bounces` times, each lower by `keep` (0..1), landing for good at
 * t = 1. Returns the height (0 = on the ground) and whether t is at a landing (the frame to squash on).
 */
export function bounce(t: number, bounces = 2, keep = 0.45): { h: number; landing: boolean } {
  // Arc k (k = 0: the fall, a half arc) lasts sqrt(height_k); heights are keep^k.
  const arcs: number[] = [Math.sqrt(1) / 2];
  for (let k = 1; k <= bounces; k++) arcs.push(Math.sqrt(keep ** k));
  const total = arcs.reduce((a, b) => a + b, 0);
  let u = Math.min(1, Math.max(0, t)) * total;
  for (let k = 0; k < arcs.length; k++) {
    if (u <= arcs[k] || k === arcs.length - 1) {
      const peak = keep ** k;
      if (k === 0) {
        const s = u / arcs[0]; // falling from the top: h = 1 - s^2
        return { h: Math.max(0, 1 - s * s), landing: s >= 0.999 };
      }
      const s = (2 * u) / arcs[k] - 1; // -1..1 across the arc
      return { h: Math.max(0, peak * (1 - s * s)), landing: s >= 0.999 };
    }
    u -= arcs[k];
  }
  return { h: 0, landing: true };
}

/** A deterministic shake offset in [-1, 1] for frame i (alternating sides, jittered by the seed). */
export function shakeAt(i: number, seed = 1): { x: number; y: number } {
  const r = (n: number) => {
    let h = Math.imul(n ^ (seed * 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
  };
  const side = i % 2 === 0 ? 1 : -1;
  return { x: side * (0.6 + 0.4 * Math.abs(r(i * 2 + 1))), y: r(i * 2 + 2) * 0.5 };
}
