// FX placement (#97): one owner for putting a library effect or recipe on a sprite. add_fx, fx_from_recipe's
// layer and fx_overlay plan their destination timing (which sprite frames, at which effect times) and hand it
// here; planPlacement renders the effect at those times with one seed, palette and canvas, places it by its anchor,
// cuts it to the sprite, splits color and glow (Addition) and builds the FX record. The same plan is written by
// writePlacement (one put_images request) or shown over the sprite by previewPlacement, so a context preview and
// the placement never disagree.
import type { Counted, RGBA } from "../color.js";
import { quantize } from "../color.js";
import type { Document, FrameInsert, PutImagesItem, SpriteInfo } from "../document.js";
import { bounds, contactSheet, encodePng, snapToPalette, type Rgba } from "../image.js";
import type { Content } from "../tool.js";
import { renderFx, visualCenter } from "./index.js";
import type { FxAnchor, FxEntry } from "./library.js";
import { aiLayer, buildRecord, freeLayerName, glowBase, renderRecord, type FxRecord, type RenderInput } from "./record.js";

/** One sprite frame the effect lands on and the effect's time there (ms; wrapped into the loop for loops). */
export interface FxSample { frame: number; t: number }

/**
 * Which sprite frames an effect covers from `start`, timed by the sprite's frame durations: each frame shows
 * the effect at the frame's start time. A one-shot runs until its duration; a loop wraps and fills every frame
 * to the end, and at least one whole loop. Frames past the sprite's end last newFrameMs; `frames` is the
 * frame count the sprite needs.
 */
export function fxSchedule(durations: number[], start: number, effectMs: number, loop: boolean, newFrameMs: number): { samples: FxSample[]; frames: number } {
  const samples: FxSample[] = [];
  let t = 0;
  for (let f = start; ; f++) {
    const exists = f <= durations.length;
    if (loop ? !exists && t >= effectMs : t >= effectMs) break;
    samples.push({ frame: f, t: loop ? t % effectMs : t });
    t += exists ? durations[f - 1] : newFrameMs;
  }
  return { samples, frames: Math.max(durations.length, samples.at(-1)?.frame ?? 0) };
}

/** The pixels of img (alpha > 0) inside the sprite once its top-left sits at (ox, oy), cut out; undefined when none. */
export function placed(img: Rgba, ox: number, oy: number, spriteW: number, spriteH: number): { image: Rgba; x: number; y: number } | undefined {
  const b = bounds(img, 1);
  if (!b) return undefined;
  const x0 = Math.max(b.x, -ox), y0 = Math.max(b.y, -oy);
  const x1 = Math.min(b.x + b.w, spriteW - ox), y1 = Math.min(b.y + b.h, spriteH - oy);
  if (x1 <= x0 || y1 <= y0) return undefined;
  const w = x1 - x0, h = y1 - y0, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1) * 4), y * w * 4);
  return { image: { width: w, height: h, data }, x: ox + x0, y: oy + y0 };
}

/** Visual centres by effect module (a recipe's id can name several recipes), then by options, seed and canvas. */
const centers = new WeakMap<object, Map<string, { x: number; y: number }>>();

/**
 * The point of the effect's canvas that goes at the caller's (x, y): its origin for "ground", its visual centre
 * for "center" (visualCenter over a render at the effect's own fps, so it depends only on the effect, its options,
 * seed and canvas, not on the sprite's timing; cached). Shared by every tool that places an effect.
 */
export function fxAnchorPoint(e: FxEntry, anchor: FxAnchor, opts: Record<string, unknown>, seed: number,
  canvas: { width: number; height: number; x: number; y: number }): { x: number; y: number } {
  if (anchor === "ground") return { x: canvas.x, y: canvas.y };
  const key = JSON.stringify([opts, seed, canvas]);
  let byKey = centers.get(e.module);
  if (!byKey) centers.set(e.module, (byKey = new Map()));
  let c = byKey.get(key);
  if (!c) {
    c = visualCenter(renderFx(e.module, opts, { fps: e.fps, seed, canvas }).frames) ?? { x: canvas.x, y: canvas.y };
    if (byKey.size > 200) byKey.clear();
    byKey.set(key, c);
  }
  return c;
}

/** pixelfx act data: the effect's hits with freeze, shake and amp (seconds in the source). */
interface ActHit { t: number; stop?: number; shake?: number; amp?: number }

/**
 * The effect's impact: its first act hit when it has act data (melee effects), else the start of its busiest
 * frame (the largest alpha sum at its own fps), as for its visual centre. act is what pixelfx's act data
 * suggests for hit_stop (freeze and shake in ms, amp in px). Its ms is the windup export reports (#71).
 */
export function fxImpact(e: FxEntry, opts: Record<string, unknown>, seed: number,
  canvas: { width: number; height: number; x: number; y: number }): { ms: number; from: "act" | "busiest frame"; act?: { freezeMs: number; shakeMs: number; amp: number } } {
  const hit = ((e.module as unknown as { act?: { hits?: ActHit[] } }).act?.hits ?? [])[0];
  if (hit) {
    return { ms: Math.round(hit.t * 1000), from: "act", act: { freezeMs: Math.round((hit.stop ?? 0) * 1000), shakeMs: Math.round((hit.shake ?? 0) * 1000), amp: hit.amp ?? 0 } };
  }
  const r = renderFx(e.module, opts, { fps: e.fps, seed, canvas });
  let best = 0, bestSum = -1;
  r.frames.forEach((f, i) => {
    let s = 0;
    for (let j = 3; j < f.data.length; j += 4) s += f.data[j];
    if (s > bestSum) { bestSum = s; best = i; }
  });
  return { ms: Math.round((best * 1000) / e.fps), from: "busiest frame" };
}

/** "#rrggbb" of an opaque RGB triple. */
const hex6 = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** The distinct RGB colors (any alpha above 0) of the images, as "#rrggbb", dark to bright then by hex. */
export function fxColors(images: Rgba[]): string[] {
  const seen = new Map<string, number>();
  for (const im of images) {
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const h = hex6(d[i], d[i + 1], d[i + 2]);
      if (!seen.has(h)) seen.set(h, 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
  }
  return [...seen].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h);
}

/** The most entries an indexed sprite's palette takes before add_fx snaps instead of appending (RGB palettes grow past it). */
export const FX_PALETTE_CAP = 256;

/**
 * The palette for an effect's color items, shared by the placing tools. By default (palette undefined) the colors
 * on the Normal effect layer join the sprite palette (returned as `append`, for put_images' palette, so it is the
 * same undo step; the glow layer is light, not palette pixels); in an indexed sprite, past FX_PALETTE_CAP entries the items are snapped
 * to the sprite palette instead (in place). A ramp or 'sprite' leaves the sprite palette alone.
 */
export async function fxPalette(doc: Document, info: SpriteInfo, colorItems: PutImagesItem[], palette: unknown): Promise<{ append?: string[]; note: string }> {
  if (palette !== undefined || !colorItems.length) return { note: "" };
  const current = await doc.palette();
  const have = new Set(current.map((c) => (c.a < 255 ? hex6(c.r, c.g, c.b) + c.a.toString(16).padStart(2, "0") : hex6(c.r, c.g, c.b))));
  const missing = fxColors(colorItems.map((it) => it.image)).filter((h) => !have.has(h));
  if (info.colorMode !== "indexed" || current.length + missing.length <= FX_PALETTE_CAP) {
    return {
      append: missing,
      note: missing.length
        ? ` Added its ${missing.length} color${missing.length === 1 ? "" : "s"} to the sprite palette (${current.length + missing.length} entries).`
        : " Its colors were already in the sprite palette.",
    };
  }
  if (!info.palette.length) return { note: "" };
  for (const it of colorItems) it.image = snapToPalette(it.image, info.palette, 1);
  return {
    note: ` Its ${missing.length} new colors would take the sprite palette past ${FX_PALETTE_CAP} entries ` +
      `(it has ${current.length}), so they were snapped to the sprite palette instead.`,
  };
}

/** At most k colors for the images (median cut over 5-bit buckets, so huge color counts stay fast). */
export function reducedPalette(images: Rgba[], k: number): RGBA[] {
  const buckets = new Map<number, Counted>();
  for (const im of images) {
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      const b = buckets.get(key);
      if (b) b.count++;
      else buckets.set(key, { r: d[i], g: d[i + 1], b: d[i + 2], a: 255, count: 1 });
    }
  }
  return quantize([...buckets.values()], k, "median-cut").map(({ r, g, b }) => ({ r, g, b, a: 255 }));
}

// ---- One placement.

export interface PlacementInput {
  e: FxEntry;
  /** The effect's options (effectOptions over the render input). */
  opts: Record<string, unknown>;
  /** The render input as given (seed, flip, angle, options, palette, light), recorded as `render`. */
  render: RenderInput;
  seed: number;
  canvas: { width: number; height: number; x: number; y: number };
  anchor: FxAnchor;
  /** Where the anchor goes (sprite pixels). */
  x: number;
  y: number;
  /** The destination timing: sprite frames and effect times (ms). */
  samples: FxSample[];
  glow: "layer" | "baked" | "none";
  /** palette 'sprite': the sprite palette to snap to. */
  snap?: RGBA[];
  /** The frame rate recorded (and used for frames added past the end). */
  fps: number;
  /** A recipe's JSON, recorded with the effect. */
  recipe?: string;
}

export interface Placement {
  /** The effect layer's base name (new_layer): 'fx <id>' or numbered. */
  main: string;
  colorItems: PutImagesItem[];
  glowItems: PutImagesItem[];
  /** The FX record, on the color layer (or the glow layer when the color layer is empty). */
  record: FxRecord & { layer: string };
  impact: ReturnType<typeof fxImpact>;
  /** The canvas's top-left on the sprite. */
  left: number;
  top: number;
  samples: FxSample[];
}

/**
 * Renders the effect at the destination times, places it by its anchor, cuts it to the sprite and builds the FX
 * record. Undefined when nothing lands on the sprite.
 */
export function planPlacement(info: SpriteInfo, p: PlacementInput): Placement | undefined {
  const { e, opts, seed, canvas, samples, glow } = p;
  const r = renderFx(e.module, opts, { times: samples.map((s) => s.t / 1000), seed, canvas, palette: p.snap });
  const main = freeLayerName(info, e.id);
  const at = fxAnchorPoint(e, p.anchor, opts, seed, canvas);
  const left = p.x - at.x, top = p.y - at.y;
  const colorItems: PutImagesItem[] = [], glowItems: PutImagesItem[] = [];
  samples.forEach((s, i) => {
    const c = placed(glow === "baked" ? r.frames[i] : r.color[i], left, top, info.width, info.height);
    if (c) colorItems.push({ image: c.image, x: c.x, y: c.y, frame: s.frame, newLayer: main });
    if (glow !== "layer") return;
    const g = placed(r.glow[i], left, top, info.width, info.height);
    if (g) glowItems.push({ image: g.image, x: g.x, y: g.y, frame: s.frame, newLayer: glowBase(main), blendMode: "addition" });
  });
  if (colorItems.length) for (const g of glowItems) g.above = aiLayer(main);
  if (!colorItems.length && !glowItems.length) return undefined;
  const impact = fxImpact(e, opts, seed, canvas);
  const render = renderRecord(e, p.render);
  const record = {
    layer: aiLayer(colorItems.length ? main : glowBase(main)),
    ...buildRecord({ id: e.id, x: left + canvas.x, y: top + canvas.y, fps: p.fps, loop: e.loop, windupMs: impact.ms, recipe: p.recipe, render }),
  };
  return { main, colorItems, glowItems, record, impact, left, top, samples };
}

/** Writes a placement, its palette and its FX record in one put_images request (one undo step). */
export async function writePlacement(doc: Document, info: SpriteInfo, pl: Placement, o: {
  palette: unknown; label: string; prompt: string; frames?: number; duration?: number; insert?: FrameInsert[]; durations?: { frame: number; ms: number }[];
}) {
  const { append, note } = await fxPalette(doc, info, pl.colorItems, o.palette);
  const res = await doc.putImages([...pl.colorItems, ...pl.glowItems], {
    frames: o.frames, duration: o.duration, insert: o.insert, durations: o.durations, label: o.label, prompt: o.prompt, palette: append,
    fx: pl.record,
  });
  return { res, paletteNote: note };
}

const BACKDROP: RGBA = { r: 30, g: 30, b: 40, a: 255 };
const LABEL: RGBA = { r: 224, g: 224, b: 224, a: 255 };

/** dst += src at (x, y): normal blend for color, additive for glow (both cut to dst). */
function stamp(dst: Rgba, src: Rgba, x: number, y: number, add: boolean) {
  for (let j = 0; j < src.height; j++) for (let i = 0; i < src.width; i++) {
    const X = x + i, Y = y + j;
    if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
    const s = (j * src.width + i) * 4, d = (Y * dst.width + X) * 4, a = src.data[s + 3] / 255;
    if (!a) continue;
    for (let k = 0; k < 3; k++) {
      dst.data[d + k] = add ? Math.min(255, dst.data[d + k] + Math.round(src.data[s + k] * a))
        : Math.round(dst.data[d + k] * (1 - a) + src.data[s + k] * a);
    }
    if (!add) dst.data[d + 3] = 255;
  }
}

/**
 * A context preview: each frame the placement writes, over the sprite's own art in that frame (sourceOf: the frame
 * whose art a frame that would be inserted shows; frames past the end show the last one), with the glow added, labelled with its sprite frame.
 * The same items writePlacement would write, so what is shown is what gets placed. Nothing changes.
 */
export async function previewPlacement(doc: Document, info: SpriteInfo, pl: Placement,
  o: { sourceOf?: (frame: number) => number; zoom?: number } = {}): Promise<Content> {
  const frames: Rgba[] = [];
  const art = new Map<number, Rgba>();
  for (const s of pl.samples) {
    const src = Math.max(1, Math.min(info.durations.length, o.sourceOf ? o.sourceOf(s.frame) : s.frame));
    if (!art.has(src)) art.set(src, await doc.pixels(undefined, src));
    const base = art.get(src)!;
    const img: Rgba = { width: info.width, height: info.height, data: new Uint8Array(info.width * info.height * 4) };
    for (let i = 0; i < img.data.length; i += 4) img.data.set([BACKDROP.r, BACKDROP.g, BACKDROP.b, 255], i);
    stamp(img, base, 0, 0, false);
    for (const it of pl.colorItems.filter((c) => c.frame === s.frame)) stamp(img, it.image, it.x ?? 0, it.y ?? 0, false);
    for (const it of pl.glowItems.filter((c) => c.frame === s.frame)) stamp(img, it.image, it.x ?? 0, it.y ?? 0, true);
    frames.push(img);
  }
  const z = o.zoom ?? (info.width <= 64 ? 3 : info.width <= 160 ? 2 : 1);
  const columns = Math.max(1, Math.min(frames.length, Math.floor(1200 / (info.width * z + 4))));
  const sheet = contactSheet(frames, { labels: pl.samples.map((s) => String(s.frame)), columns, zoom: z, background: BACKDROP, labelColor: LABEL });
  return { type: "image", data: encodePng(sheet).toString("base64"), mimeType: "image/png" };
}
