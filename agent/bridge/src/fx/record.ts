// The FX domain's records (#97): one owner for what the FX tools store on a sprite and read back.
// - Layer naming: every effect goes on 'AI: fx <id>' (its light on '<that> glow'); freeLayerName numbers a
//   second one so it never overwrites the first.
// - The FX record (layer property aseprite-agent "fx"): built here for every placing tool (add_fx, fx_overlay,
//   fx_from_recipe, new_fx_sprite, fluid_fx, fx_pipeline), sent as wire params, parsed back from get_state.
//   The extension stores it as given; only this module knows what its id, recipe and render mean.
// - Hits (sprite property aseprite-agent "fx.hits"): wire params and parsing.
// - Render settings: what a library effect or recipe was rendered with, stored as `render`. Re-rendering a record
//   (check_fx) is fx/render_record.ts.
// Light on purpose (document.ts parses records with it): rendering a record is fx/render_record.ts.
import { parseHex } from "../color.js";
import type { FxEntry } from "./library.js";

// ---- Layer naming.

/** The prefix of every layer the agent makes (variations.PREFIX in the extension). */
export const AI_PREFIX = "AI: ";
/** 'AI: <base>': a layer name from the name put_images' new_layer takes. */
export const aiLayer = (base: string) => AI_PREFIX + base;
/** An effect's base layer name (without the prefix): 'fx <id>'. */
export const fxBase = (id: string) => `fx ${id}`;
/** The glow (light) layer's base name for an effect's base name. */
export const glowBase = (base: string) => `${base} glow`;
/** An effect layer by name: 'AI: fx …' (its glow layer too). */
export const isFxLayerName = (name: string) => name.startsWith(`${AI_PREFIX}fx `);
/** An effect's glow layer by name: 'AI: fx … glow'. */
export const isFxGlowName = (name: string) => /^AI: fx .+ glow$/.test(name);

/** 'fx <id>' (put_images' new_layer), or with a number when that layer exists, so a second effect never overwrites the first. */
export function freeLayerName(info: { layers: { name: string }[] }, id: string): string {
  const taken = new Set(info.layers.map((l) => l.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? fxBase(id) : `${fxBase(id)} ${n}`;
    if (!taken.has(aiLayer(name)) && !taken.has(aiLayer(glowBase(name)))) return name;
  }
}

// ---- The FX record.

/**
 * What export and check_fx need about an effect on a layer (#71), in the layer property aseprite-agent "fx"
 * (get_state's layer `fx`). A property of the layer, so several effects can share a sprite and deleting the layer
 * drops its record.
 */
export interface FxRecord {
  /** The effect's id: a library id, 'recipe:<name>', 'fluid:<preset>' or 'pipeline:<name>'. */
  id: string;
  /** The effect's origin (pixelfx's ground point) in sprite pixels. */
  x: number;
  y: number;
  /** The effect's frame rate and whether it loops. */
  fps: number;
  loop: boolean;
  /** ms from the effect's start to its impact (fxImpact). */
  windupMs: number;
  /** An FX recipe's JSON (fx_from_recipe, #72) or an effect pipeline's JSON (fx_pipeline, #107). */
  recipe?: string;
  /** JSON of the render settings: those that differ from a library effect's defaults, or fluid_fx's settings. */
  render?: string;
}

/** A hit hit_stop recorded (sprite property aseprite-agent "fx.hits"), for exporters (#71). */
export interface HitRecord {
  /** The contact frame (1-based). */
  frame: number;
  /** How much longer the contact pose holds, shake included (ms). */
  freezeMs: number;
  shakeMs?: number;
  amp?: number;
}

/** The most characters recipe and render may each take (handlers_sprite.lua FX_TEXT_MAX). */
export const RECORD_TEXT_MAX = 16384;

/** An FX record with sane numbers: whole-pixel origin, whole-ms windup (at least 0). Throws on oversized text. */
export function buildRecord(o: { id: string; x: number; y: number; fps: number; loop: boolean; windupMs: number; recipe?: string; render?: string }): FxRecord {
  for (const k of ["recipe", "render"] as const) {
    if (o[k] !== undefined && o[k]!.length > RECORD_TEXT_MAX) throw new Error(`The effect's ${k} is ${o[k]!.length} characters; at most ${RECORD_TEXT_MAX} can be stored with it.`);
  }
  return {
    id: o.id, x: Math.round(o.x), y: Math.round(o.y), fps: o.fps, loop: o.loop, windupMs: Math.max(0, Math.round(o.windupMs)),
    ...(o.recipe !== undefined ? { recipe: o.recipe } : {}), ...(o.render !== undefined ? { render: o.render } : {}),
  };
}

/** An FX record as wire params (put_images' and create_animation's fx). */
export const recordWire = (f: FxRecord) => ({
  id: f.id, x: f.x, y: f.y, fps: f.fps, loop: f.loop, windup_ms: f.windupMs,
  ...(f.recipe !== undefined ? { recipe: f.recipe } : {}), ...(f.render !== undefined ? { render: f.render } : {}),
});

/** A layer's fx from get_state, as an FX record (older records without recipe or render read the same). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parseRecord = (f: any): FxRecord => ({
  id: String(f.id ?? ""), x: f.x, y: f.y, fps: f.fps, loop: !!f.loop, windupMs: f.windupMs ?? 0,
  ...(typeof f.recipe === "string" ? { recipe: f.recipe } : {}), ...(typeof f.render === "string" ? { render: f.render } : {}),
});

/** A hit as wire params (put_images' hit). */
export const hitWire = (h: HitRecord) => ({ frame: h.frame, freeze_ms: h.freezeMs, shake_ms: h.shakeMs, amp: h.amp });

/** get_state's fxHits as hit records. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parseHits = (list: any[] | undefined): HitRecord[] => (list ?? []).map((h) => ({
  frame: h.frame, freezeMs: h.freezeMs, ...(h.shakeMs !== undefined ? { shakeMs: h.shakeMs } : {}), ...(h.amp !== undefined ? { amp: h.amp } : {}),
}));

/** What made the effect, from its id. */
export function recordKind(fx: Pick<FxRecord, "id">): "recipe" | "fluid" | "pipeline" | "library" {
  if (fx.id.startsWith("recipe:")) return "recipe";
  if (fx.id.startsWith("fluid:")) return "fluid";
  if (fx.id.startsWith("pipeline:")) return "pipeline";
  return "library";
}

// ---- Render settings (a library effect or recipe).

/** The render inputs a placing tool takes (add_fx's names). */
export interface RenderInput {
  seed?: number; flip?: boolean; angle?: number; options?: Record<string, unknown>; palette?: unknown; light?: number;
}

/** The effect's options from a tool's input: its own options (checked by name), a ramp, light, flip and angle. */
export function effectOptions(e: FxEntry, input: RenderInput): Record<string, unknown> {
  const known = new Set(e.options.map((o) => o.name));
  const opts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.options ?? {})) {
    if (!known.has(k)) throw new Error(`${e.id} has no option '${k}'. Options: ${[...known].join(", ") || "none"} (palette, seed, light, flip and angle are inputs of their own).`);
    opts[k] = v;
  }
  if (Array.isArray(input.palette)) {
    for (const c of input.palette) if (!parseHex(String(c))) throw new Error(`Invalid color in palette: ${c}`);
    opts.palette = input.palette;
  }
  if (input.light !== undefined) opts.light = input.light;
  if (input.flip) opts.flip = true;
  if (input.angle) opts.angle = (input.angle * Math.PI) / 180;
  return opts;
}

/**
 * The render settings worth recording beside the FX record (its `render`, JSON) so check_fx can re-render what
 * was placed: only those that differ from the effect's defaults; undefined when none do.
 */
export function renderRecord(e: FxEntry, input: RenderInput): string | undefined {
  const r: Record<string, unknown> = {};
  if (input.seed !== undefined && input.seed !== e.seed) r.seed = input.seed;
  if (input.flip) r.flip = true;
  if (input.angle && input.angle % 360) r.angle = input.angle;
  if (input.options && Object.keys(input.options).length) r.options = input.options;
  if (Array.isArray(input.palette)) r.palette = input.palette;
  if (input.light !== undefined) r.light = input.light;
  return Object.keys(r).length ? JSON.stringify(r) : undefined;
}

/** A record's render JSON, {} when missing or broken. */
export function renderOf(fx: FxRecord): Record<string, unknown> {
  try { return fx.render ? JSON.parse(fx.render) : {}; } catch { return {}; }
}

/**
 * The canvas to render on: the effect's own, mirrored about its origin when flipped, or a square around the
 * origin big enough for any turn when rotated.
 */
export function fxCanvas(e: FxEntry, flip: boolean, angle: number): { width: number; height: number; x: number; y: number } {
  const { width: w, height: h } = e.size, { x: ox, y: oy } = e.origin;
  if (angle % 360) {
    const r = Math.ceil(Math.max(Math.hypot(ox, oy), Math.hypot(w - ox, oy), Math.hypot(ox, h - oy), Math.hypot(w - ox, h - oy))) + 1;
    return { width: 2 * r, height: 2 * r, x: r, y: r };
  }
  return { width: w, height: h, x: flip ? w - ox : ox, y: oy };
}
