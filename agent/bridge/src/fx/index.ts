// Pixel FX engine: a typed facade over the vendored pixelfx core (./vendor, see ./NOTICE.md).
// renderFx steps an effect on a fixed 120 Hz clock (pixelfx's own substep rate), samples it at the requested
// fps and returns each frame baked (color plus light, composited over transparency) and its light buffer alone,
// optionally snapped to a sprite palette.
import type { RGBA } from "../color.js";
import { snapToPalette, type Rgba } from "../image.js";
import { composite, createFrame, createFx, type EffectModule, type Frame } from "./vendor/core/index.js";

export type { EffectMeta, EffectModule } from "./vendor/core/index.js";

/** The simulation clock: pixelfx steps its sims at 120 Hz whatever the frame rate. */
const STEP_HZ = 120;

export interface RenderFxSettings {
  /** Frames per second to sample at. */
  fps: number;
  /** Random seed; overrides the effect's default seed. */
  seed: number;
  /** Snap the baked frames to these colors (the glow buffer is left as is). */
  palette?: RGBA[];
  /**
   * How many frames to render. Default: duration * fps for a loop (the frame at t = duration would repeat
   * frame 0), duration * fps + 1 for a one-shot (its last frame is at t = duration).
   */
  frames?: number;
}

export interface RenderedFx {
  /** Baked frames: color with light composited over transparency. */
  frames: Rgba[];
  /** The light buffer of each frame: additive RGB, alpha 255 where lit. */
  glow: Rgba[];
  /** Where the effect's origin sits on the canvas. */
  origin: { x: number; y: number };
  width: number;
  height: number;
  durationMs: number;
  loop: boolean;
}

/** Light buffer to RGBA bytes (the buffer is RGBA in memory on little-endian hosts; this does not rely on it). */
function lightImage(f: Frame): Rgba {
  const out = new Uint8Array(f.w * f.h * 4);
  for (let i = 0; i < f.light.length; i++) {
    const c = f.light[i];
    if (!(c & 0xffffff)) continue;
    out[i * 4] = c & 255;
    out[i * 4 + 1] = (c >>> 8) & 255;
    out[i * 4 + 2] = (c >>> 16) & 255;
    out[i * 4 + 3] = 255;
  }
  return { width: f.w, height: f.h, data: out };
}

/**
 * Render an effect module (pixelfx's effect shape) to frames. options are the effect's own options
 * (palette ramp, flip, angle, light, ...) over its defaults.
 */
export function renderFx(effect: EffectModule, options: Record<string, unknown>, settings: RenderFxSettings): RenderedFx {
  const meta = effect.meta;
  const [width, height] = meta.size;
  const [ox, oy] = meta.origin;
  const duration = meta.duration ?? 1;
  const loop = !!meta.loop;
  const fps = settings.fps;
  if (!(fps > 0)) throw new Error(`renderFx: fps must be positive, got ${fps}`);
  const n = settings.frames ?? Math.max(1, Math.round(duration * fps) + (loop ? 0 : 1));
  const inst = createFx(effect, { x: ox, y: oy, ...options, seed: settings.seed });
  const frame = createFrame(width, height);
  const frames: Rgba[] = [];
  const glow: Rgba[] = [];
  let step = 0;
  for (let i = 0; i < n; i++) {
    // Advance on a fixed 120 Hz clock: step j ends exactly at j / 120 s, so every fps sees the same steps
    // and the same times (a loop's frame at t = duration is its frame at 0). Frame times are rounded to it.
    for (const end = Math.round((i * STEP_HZ) / fps); step < end; ) {
      step++;
      inst.update(step / STEP_HZ - inst.t);
    }
    frame.color.fill(0);
    frame.light.fill(0);
    inst.draw(frame);
    const baked: Rgba = { width, height, data: composite(frame, new Uint8Array(width * height * 4), null) };
    frames.push(settings.palette ? snapToPalette(baked, settings.palette) : baked);
    glow.push(lightImage(frame));
  }
  return { frames, glow, origin: { x: ox, y: oy }, width, height, durationMs: duration * 1000, loop };
}
