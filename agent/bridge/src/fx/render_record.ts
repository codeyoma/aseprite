// Re-rendering an FX record (#97), for check_fx: a library effect or recipe (with its render settings), a fluid
// (`fluid:<preset>`, its tool settings in `render`) or an effect pipeline (`pipeline:<name>`, its JSON in `recipe`).
// Kept apart from fx/record.ts so parsing a record does not load the renderers.
import { parseHex, type RGBA } from "../color.js";
import { blank, type Rgba } from "../image.js";
import { FLUID_PRESETS, renderFluid, type Emitter, type FluidPresetName, type FluidSettings } from "../sprite_fx/fluid.js";
import { canvasOf, parsePipeline, runPipeline } from "../sprite_fx/pipeline.js";
import { renderFx } from "./index.js";
import { findFx, type FxEntry } from "./library.js";
import { parseRecipe, recipeEntry } from "./recipe.js";
import { effectOptions, fxCanvas, recordKind, renderOf, type FxRecord, type RenderInput } from "./record.js";

/** The effect an FX record names, rebuilt to render again: its recipe, else the library effect; undefined when neither. */
export function recordedEffect(fx: FxRecord): { e: FxEntry; opts: Record<string, unknown>; seed: number; flip: boolean; angle: number } | undefined {
  const kind = recordKind(fx);
  if (kind === "fluid" || kind === "pipeline") return undefined;
  let e: FxEntry | undefined;
  try {
    e = fx.recipe ? recipeEntry(parseRecipe(fx.recipe)) : findFx(fx.id);
  } catch {
    return undefined;
  }
  if (!e) return undefined;
  const render = renderOf(fx) as RenderInput;
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, render); } catch { opts = {}; }
  return { e, opts, seed: typeof render.seed === "number" ? render.seed : e.seed, flip: !!render.flip, angle: typeof render.angle === "number" ? render.angle : 0 };
}

// ---- Fluid settings (fluid_fx's input, stored in `render`).

/** fluid_fx's settings from its input (or a record's render JSON) and a resolved ramp. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fluidSettings(input: any, ramp: RGBA[]): FluidSettings {
  const fps = input.fps ?? FLUID_PRESETS[input.preset as FluidPresetName].fps;
  const frames = input.frames ?? (input.duration_ms ? Math.max(2, Math.round((input.duration_ms * fps) / 1000)) : undefined);
  return {
    preset: input.preset, width: input.width, height: input.height, frames, fps, loop: input.loop, seed: input.seed,
    ramp: ramp.length ? ramp : undefined, buoyancy: input.buoyancy, vorticity: input.vorticity,
    wind: typeof input.wind === "number" ? { x: input.wind, y: 0 } : input.wind, dissipation: input.dissipation,
    gravity: input.gravity, strength: input.strength, level: input.level, emitter: input.emitter as Emitter | undefined,
    resolution: input.resolution, threshold: input.threshold,
  };
}

/** An effect re-rendered from its record, for the spill rule. */
export type RecordRender =
  | {
    /** The effect's color frames at its own fps, on a render canvas. */
    frames: Rgba[];
    fps: number;
    durationMs: number;
    /** Where the render canvas's top-left goes on the sprite. */
    dx: number;
    dy: number;
    /** The part of the render canvas the placing tool keeps (pixels past it were cut); none when it keeps all. */
    kept?: { x: number; y: number; width: number; height: number };
    /** The effect at t = duration (one-shots that can be rendered there), on the same canvas. */
    end?: Rgba;
    /** What to change when it draws past `kept`. */
    pastFix: string;
    onSprite?: false;
  }
  /** Drawn on the sprite's own canvas (a pipeline over a layer, a fluid from a layer's pixels): nothing can spill. */
  | { onSprite: true };

/** Margin around an effect's canvas when re-rendering, to catch drawing past it (pixelfx's check uses 24). */
export const RENDER_MARGIN = 32;

/**
 * Re-renders an FX record for check_fx: a library effect or recipe (render settings applied, on its canvas with a
 * margin), a fluid from its settings, or a pipeline on a blank canvas (with the sprite's palette). undefined when
 * the record cannot be rendered (an unknown id, a broken JSON).
 */
export function rerender(fx: FxRecord, ctx: { sprite: { width: number; height: number }; palette?: RGBA[] }): RecordRender | undefined {
  const kind = recordKind(fx);
  if (kind === "fluid") {
    const input = renderOf(fx) as Record<string, unknown>;
    const preset = input.preset ?? fx.id.slice("fluid:".length);
    if (!(String(preset) in FLUID_PRESETS)) return undefined;
    if (input.emit_layer !== undefined) return { onSprite: true };
    // A ramp only colors the field, so a stored 'sprite' (older records) renders with the preset's.
    const ramp = Array.isArray(input.colors) ? input.colors.map((h) => parseHex(String(h))).filter((c): c is RGBA => !!c).map((c) => ({ ...c, a: 255 })) : [];
    try {
      const r = renderFluid(fluidSettings({ ...input, preset }, ramp.length >= 2 ? ramp : []));
      return { frames: r.frames, fps: r.fps, durationMs: r.durationMs, dx: fx.x - r.origin.x, dy: fx.y - r.origin.y, pastFix: "" };
    } catch { return undefined; }
  }
  if (kind === "pipeline") {
    if (!fx.recipe) return undefined;
    let p;
    try { p = parsePipeline(fx.recipe); } catch { return undefined; }
    const canvas = canvasOf(p);
    if (!canvas) return { onSprite: true };
    const count = typeof p.frames === "number" ? p.frames : 8;
    try {
      const res = runPipeline(p, Array.from({ length: count }, () => blank(canvas.w, canvas.h)), ctx.palette ?? []);
      const x = canvas.x ?? fx.x - Math.floor(canvas.w / 2), y = canvas.y ?? fx.y - Math.floor(canvas.h / 2);
      return { frames: res.frames, fps: p.fps ?? 12, durationMs: Math.round((count * 1000) / (p.fps ?? 12)), dx: x, dy: y, pastFix: "" };
    } catch { return undefined; }
  }
  const rec = recordedEffect(fx);
  if (!rec) return undefined;
  const c = fxCanvas(rec.e, rec.flip, rec.angle);
  const M = RENDER_MARGIN;
  const canvas = { width: c.width + 2 * M, height: c.height + 2 * M, x: c.x + M, y: c.y + M };
  const r = renderFx(rec.e.module, rec.opts, { fps: fx.fps, seed: rec.seed, canvas });
  const end = rec.e.loop ? undefined : renderFx(rec.e.module, rec.opts, { times: [rec.e.durationMs / 1000], seed: rec.seed, canvas }).color[0];
  return {
    frames: r.color, fps: fx.fps, durationMs: rec.e.durationMs, dx: fx.x - canvas.x, dy: fx.y - canvas.y,
    kept: { x: M, y: M, width: c.width, height: c.height }, end,
    pastFix: fx.recipe ? "grow the recipe's size or move its origin, or slow the particles" : "use a smaller option (height, radius) or another effect",
  };
}
