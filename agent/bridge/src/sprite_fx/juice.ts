// Juice (#104): squash and stretch, jelly wobble, bounce, shake, flash, pulse, spin, lean and pop, made from a
// sprite's own pixels. juicePlan turns an effect and its options into one Warp (raster.ts) per output frame; the
// curves are curves.ts. Squash and stretch keep the area (sx = 1 / sy, Thomas & Johnston's volume rule); springs
// are a damped harmonic oscillator; shakes are integer offsets that decay (Eiserloh's trauma shake, linear here).
import type { Rect } from "../image.js";
import { bounce, ease, shakeAt, spring, type Ease } from "./curves.js";
import type { Warp } from "./raster.js";

export type JuiceEffect = "squash" | "stretch" | "wobble" | "bounce" | "shake" | "flash" | "pulse" | "spin" | "lean" | "pop_in" | "pop_out";

export const JUICE_EFFECTS: JuiceEffect[] = ["squash", "stretch", "wobble", "bounce", "shake", "flash", "pulse", "spin", "lean", "pop_in", "pop_out"];

export interface JuiceOptions {
  /** Strength, 0..1 (squash, stretch, wobble, pulse, lean): how far the shape deforms at the peak. */
  amount?: number;
  /** Pixels: the shake's size, the wobble's sway at the top, the bounce's drop height. */
  px?: number;
  /** Spring oscillations over the effect (squash, stretch, wobble, lean). */
  cycles?: number;
  /** Spring damping ratio: low rings longer, 1 settles without overshoot. */
  damping?: number;
  /** Bounces after the first landing (bounce). */
  bounces?: number;
  /** Turns (spin): 1 is a full turn; negative turns the other way. */
  turns?: number;
  /** Easing for pulse, pop_in and pop_out. */
  ease?: Ease;
  seed?: number;
}

/** What each effect does when it has no options: frames, pivot, and defaults (shown by the tool). */
export const JUICE_DEFAULTS: Record<JuiceEffect, { frames: number; pivot: "bottom" | "center"; what: string }> = {
  squash: { frames: 6, pivot: "bottom", what: "lands flattened (wide and short, area kept) and springs back" },
  stretch: { frames: 6, pivot: "bottom", what: "shoots up tall and thin (area kept) and springs back" },
  wobble: { frames: 8, pivot: "bottom", what: "jelly sway: rows lean further the higher they are, ringing down; the base stays put" },
  bounce: { frames: 10, pivot: "bottom", what: "drops from px above, bounces lower each time, squashing on each landing" },
  shake: { frames: 6, pivot: "center", what: "jitters sideways by px, decaying to rest" },
  flash: { frames: 4, pivot: "center", what: "blinks the flash color on every other frame" },
  pulse: { frames: 6, pivot: "center", what: "swells by amount and comes back (one beat)" },
  spin: { frames: 8, pivot: "center", what: "turns around its centre in even steps (pixel-safe rotation); loops" },
  lean: { frames: 8, pivot: "bottom", what: "leans sideways (top moves, base stays) and sways back like a spring" },
  pop_in: { frames: 6, pivot: "bottom", what: "grows from nothing with an overshoot (appear)" },
  pop_out: { frames: 5, pivot: "bottom", what: "anticipates, then shrinks to nothing (disappear)" },
};

export interface JuiceFrame {
  warp: Warp;
  /** Show the flash color on this frame. */
  flash?: boolean;
}

/** Area-preserving squash or stretch: sy = 1 + k, sx = 1 / sy (k < 0 squashes). */
const keepArea = (k: number): Warp => {
  const sy = Math.max(0.2, 1 + k);
  return { sx: 1 / sy, sy };
};

/** One Warp per frame for `effect` over `frames` frames of content in `box` (the opaque bounds of the source). */
export function juicePlan(effect: JuiceEffect, frames: number, box: Rect, o: JuiceOptions = {}): JuiceFrame[] {
  const n = Math.max(1, frames);
  const out: JuiceFrame[] = [];
  const cycles = o.cycles, damping = o.damping;
  for (let i = 0; i < n; i++) {
    // Decaying effects start at the peak (t = 0) and end near rest; tweens end on their last frame.
    const decay = i / n, tween = n === 1 ? 1 : (i + 1) / n;
    switch (effect) {
      case "squash":
        out.push({ warp: keepArea(-(o.amount ?? 0.35) * spring(decay, cycles ?? 1.5, damping ?? 0.35)) });
        break;
      case "stretch":
        out.push({ warp: keepArea((o.amount ?? 0.35) * spring(decay, cycles ?? 1.5, damping ?? 0.35)) });
        break;
      case "wobble": {
        const h = Math.max(1, box.h), amp = o.px ?? Math.max(1, Math.round(box.h * 0.15 * ((o.amount ?? 0.5) / 0.5)));
        const c = cycles ?? 2, z = damping ?? 0.25;
        // Higher rows lag a little behind (phase delay), which reads as jelly rather than a lean.
        out.push({
          warp: {
            ...keepArea(-0.08 * (o.amount ?? 0.5) * spring(decay, c * 2, z)),
            wave: (above) => {
              const f = Math.min(1, Math.max(0, above / h));
              return amp * f * spring(Math.max(0, decay - f * 0.08), c, z);
            },
          },
        });
        break;
      }
      case "bounce": {
        const t = n === 1 ? 1 : i / (n - 1);
        const b = bounce(t, o.bounces ?? 2, 0.45);
        const height = o.px ?? Math.max(2, Math.round(box.h * 0.6));
        const near = b.h < 0.06;
        out.push({ warp: { ...(near && i > 0 ? keepArea(-(o.amount ?? 0.3) * (i === n - 1 ? 0.5 : 1)) : {}), dy: -Math.round(height * b.h) } });
        break;
      }
      case "shake": {
        const s = shakeAt(i, o.seed ?? 1), amp = o.px ?? 2, left = 1 - decay;
        out.push({ warp: { dx: Math.round(amp * left * s.x), dy: Math.round(amp * left * s.y) } });
        break;
      }
      case "flash":
        out.push({ warp: {}, flash: i % 2 === 0 });
        break;
      case "pulse": {
        const k = (o.amount ?? 0.2) * Math.sin(Math.PI * ease(o.ease ?? "in_out_quad", (i + 1) / (n + 1)));
        out.push({ warp: { sx: 1 + k, sy: 1 + k } });
        break;
      }
      case "spin":
        out.push({ warp: { rot: (o.turns ?? 1) * 2 * Math.PI * (i / n) } });
        break;
      case "lean":
        out.push({ warp: { kx: (o.amount ?? 0.3) * spring(decay, cycles ?? 1.5, damping ?? 0.3) } });
        break;
      case "pop_in": {
        const s = ease(o.ease ?? "out_back", tween);
        out.push({ warp: { sx: s, sy: s } });
        break;
      }
      case "pop_out": {
        // A little swell first (anticipation), then down to nothing.
        const s = i === 0 ? 1 + 0.15 * (o.amount ?? 1) : 1 - ease(o.ease ?? "in_back", tween);
        out.push({ warp: { sx: Math.max(0, s), sy: Math.max(0, s) } });
        break;
      }
    }
  }
  return out;
}
