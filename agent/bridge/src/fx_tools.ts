// Pixel FX tools (#69): list the FX library, preview an effect as a labelled contact sheet, add one to the
// active sprite on 'AI: fx <id>' layers (glow on an Addition layer) in one undo step, or make it a sprite.
import * as z from "zod/v4";
import { parseHex, quantize, type Counted, type RGBA } from "./color.js";
import { documentOf, type Document, type PutImagesItem, type SpriteInfo } from "./document.js";
import { renderFx, visualCenter, type RenderedFx } from "./fx/index.js";
import { FX_CATEGORIES, FX_LIBRARY, findFx, searchFx, type FxAnchor, type FxEntry } from "./fx/library.js";
import { bounds, contactSheet, encodePng, snapToPalette, type Rect, type Rgba } from "./image.js";
import { failure, text, type Tool, type ToolContext, type ToolResult } from "./tool.js";

export const hexList = z.array(z.string()).min(1);
export const optionsInput = z.record(z.string(), z.unknown()).optional()
  .describe("The effect's own options over its defaults (list_fx shows them), e.g. { height: 30 } or a color ramp like { sparks: ['#..'] }.");

/** An effect by id, or a failure that names the close ones. */
export function lookup(id: string): FxEntry | ToolResult {
  const e = findFx(id);
  if (e) return e;
  const near = searchFx({ query: id.split(/[-_\s]+/)[0] }).slice(0, 8).map((x) => x.id);
  return failure(`No effect named '${id}'.${near.length ? ` Close: ${near.join(", ")}.` : ""} list_fx lists them all.`);
}
export const isFailure = (x: FxEntry | ToolResult): x is ToolResult => "content" in x;

/** The effect's options from a tool's input: its own options (checked by name), a ramp, light, flip and angle. */
export function effectOptions(e: FxEntry, input: { options?: Record<string, unknown>; palette?: unknown; light?: number; flip?: boolean; angle?: number }): Record<string, unknown> {
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

export const anchorInput = z.enum(["center", "ground"]).optional()
  .describe("What x, y means. 'center': the effect's visual centre goes there (the impact point). 'ground': its origin " +
    "(the ground point under a pillar, fire or explosion) goes there. Default: the effect's own (list_fx).");

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
function reducedPalette(images: Rgba[], k: number): RGBA[] {
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

/** 'AI: fx <id>', or with a number when that layer exists, so a second effect never overwrites the first. */
export function freeLayerName(info: SpriteInfo, id: string): string {
  const taken = new Set(info.layers.map((l) => l.name));
  for (let n = 1; ; n++) {
    const name = n === 1 ? `fx ${id}` : `fx ${id} ${n}`;
    if (!taken.has(`AI: ${name}`) && !taken.has(`AI: ${name} glow`)) return name;
  }
}

const summary = (e: FxEntry) =>
  `${e.id}: ${e.title} (${e.category}, ${e.loop ? "loop" : "one-shot"} ${e.durationMs / 1000} s, ${e.size.width}x${e.size.height}, ` +
  `origin ${e.origin.x},${e.origin.y}, anchor ${e.anchor}, ${e.fps} fps)`;

const optionText = (e: FxEntry) => [
  `palette (${e.palette.length} colors, dark to bright: ${e.palette.join(" ")})`,
  ...e.options.map((o) => `${o.name} = ${JSON.stringify(o.default)}${o.kind === "ramp" ? " (ramp)" : ""}`),
].join("; ");

/** Union of the content bounds (alpha > 0) of every frame, padded by 1 px, inside the canvas. */
function unionBounds(frames: Rgba[]): Rect | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const f of frames) {
    const b = bounds(f, 1);
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x1 < 0) return undefined;
  const W = frames[0].width, H = frames[0].height;
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(W, x1 + 1); y1 = Math.min(H, y1 + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function crop(img: Rgba, r: Rect): Rgba {
  const data = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) data.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data };
}

const BACKDROP: RGBA = { r: 30, g: 30, b: 40, a: 255 };
const LABEL: RGBA = { r: 224, g: 224, b: 224, a: 255 };

export const FX_TOOLS: Tool[] = [
  {
    name: "list_fx",
    title: "List effects",
    description:
      "List the Pixel FX library: game effects rendered as pixel art (impacts, melee slashes, explosions, lightning, " +
      "arcane, holy, fire, poison). Each line gives the id, loop or one-shot, duration, canvas size, origin (pixelfx's " +
      "ground point: a character's feet for melee and casts, a torch's base), its default anchor for add_fx ('center': " +
      "x, y is the effect's visual centre, the impact point; 'ground': x, y is its origin) and its options. " +
      `Categories: ${FX_CATEGORIES.join(", ")}.`,
    input: z.object({
      query: z.string().optional().describe("Words to match in the id, name, description or tags, e.g. 'slash' or 'fire loop'."),
      category: z.string().optional().describe(`One of ${FX_CATEGORIES.join(", ")}.`),
      loop: z.boolean().optional().describe("true: loops only (torches, auras); false: one-shots only."),
    }),
    kind: "read",
    label: () => "List effects",
    async run(input) {
      if (input.category && !FX_CATEGORIES.includes(String(input.category).toLowerCase())) {
        return failure(`No category '${input.category}'. Categories: ${FX_CATEGORIES.join(", ")}.`);
      }
      const found = searchFx(input);
      if (!found.length) return { content: [text(`No effect matches. ${FX_LIBRARY.length} effects in: ${FX_CATEGORIES.join(", ")}.`)] };
      const lines = found.map((e) => `- ${summary(e)}: ${e.description}\n  Options: ${optionText(e)}`);
      return { content: [text(`${found.length} effect${found.length === 1 ? "" : "s"}:\n${lines.join("\n")}`)] };
    },
  },
  {
    name: "preview_fx",
    title: "Preview effect",
    description:
      "Render an effect from the FX library as a contact sheet PNG: its frames in a grid, numbered, on a dark backdrop " +
      "with the glow baked in, cut to where the effect draws. Use it to see the motion before add_fx (a GIF shows only " +
      "its first frame). Nothing changes in the sprite.",
    input: z.object({
      id: z.string().describe("Effect id from list_fx, e.g. 'hit-spark'."),
      options: optionsInput,
      palette: hexList.optional().describe("The effect's main color ramp, dark to bright (any length)."),
      frames: z.number().int().min(1).max(64).optional().describe("How many frames to show, evenly spread. Default all, up to 24."),
      zoom: z.number().int().min(1).max(8).optional().describe("Scale. Default 3 for small effects, 2 or 1 for big ones."),
      fps: z.number().min(1).max(60).optional().describe("Frame rate to sample at. Default the effect's own."),
      seed: z.number().int().optional(),
    }),
    kind: "read",
    label: () => "Preview effect",
    async run(input) {
      const e = lookup(input.id);
      if (isFailure(e)) return e;
      return previewFx(e, input);
    },
  },
  {
    name: "add_fx",
    title: "Add effect",
    description:
      "Add an effect from the FX library to the active sprite, in one undo step. x, y (or a slice's center) is where " +
      "the effect lands, by its anchor: 'center' puts its visual centre there (the impact point of a hit, slash, burst " +
      "or bolt), 'ground' puts its origin there (the floor under a pillar, fire, explosion or magic circle). Each effect " +
      "has a default anchor (list_fx). Unless palette is 'sprite' or a ramp, the effect's colors are appended to the " +
      "sprite palette (in the same undo step; in an indexed sprite past 256 entries they are snapped to it instead). From start_frame, " +
      "each sprite frame shows the effect at that frame's start time (using the sprite's frame durations); a one-shot " +
      "ends when its duration is up, a loop wraps and fills every frame to the end. When the effect outlasts the " +
      "sprite, frames are added at the end (copies of the last frame, 1000/fps ms each). The effect goes on a new " +
      "'AI: fx <id>' layer above the active layer; glow 'layer' (default) puts its light on 'AI: fx <id> glow' with " +
      "Addition blend, 'baked' paints it into the colors, 'none' leaves it out.",
    input: z.object({
      id: z.string().describe("Effect id from list_fx, e.g. 'hit-spark'."),
      x: z.number().int().optional().describe("Where the effect's anchor goes (see anchor). Default: the slice's center, else the sprite's center."),
      y: z.number().int().optional(),
      anchor: anchorInput,
      slice: z.string().optional().describe("Put the anchor at this slice's center."),
      start_frame: z.number().int().min(1).optional().describe("The first frame the effect is on. Default the active frame."),
      flip: z.boolean().optional().describe("Mirror it (directional effects face right)."),
      angle: z.number().optional().describe("Turn it about its origin, in degrees (clockwise on screen)."),
      seed: z.number().int().optional().describe("Another seed gives another variation of sparks and debris."),
      palette: z.union([z.literal("sprite"), hexList]).optional()
        .describe("'sprite': snap the colors to the sprite palette; or the effect's main color ramp, dark to bright (any " +
          "length), leaving the sprite palette alone. Default: the effect's colors, appended to the sprite palette."),
      light: z.number().min(0).max(4).optional().describe("Glow strength. Default 1."),
      glow: z.enum(["layer", "baked", "none"]).optional().describe("Default 'layer'."),
      fps: z.number().min(1).max(60).optional().describe("Frame rate of frames added past the sprite's end. Default the effect's own."),
      options: optionsInput,
    }),
    kind: "edit",
    label: (a) => (a?.id ? `Add effect ${a.id}` : "Add effect"),
    async run(input, ctx) {
      const e = lookup(input.id);
      if (isFailure(e)) return e;
      return placeFx(ctx, e, input);
    },
  },
  {
    name: "new_fx_sprite",
    title: "Effect as a new sprite",
    description:
      "Make an effect from the FX library its own sprite: its canvas, every frame at fps (frame durations 1000/fps " +
      "ms), glow baked in, a tag named after the effect, and the effect's colors as its palette (reduced to 256 and " +
      "the frames snapped to them when there are more). A one-shot ends on an empty frame.",
    input: z.object({
      id: z.string().describe("Effect id from list_fx."),
      options: optionsInput,
      fps: z.number().min(1).max(60).optional().describe("Default the effect's own (usually 30)."),
      seed: z.number().int().optional(),
      palette: hexList.optional().describe("The effect's main color ramp, dark to bright (any length)."),
      light: z.number().min(0).max(4).optional().describe("Glow strength. Default 1."),
    }),
    kind: "edit",
    label: () => "New effect sprite",
    async run(input, ctx) {
      const e = lookup(input.id);
      if (isFailure(e)) return e;
      return fxSprite(ctx, e, input);
    },
  },
];

/** What placeFx, fxSprite and previewFx take: add_fx's inputs (preview and sprite use the ones they need). */
export interface FxPlaceInput {
  x?: number; y?: number; anchor?: FxAnchor; slice?: string; start_frame?: number; flip?: boolean; angle?: number;
  seed?: number; palette?: "sprite" | string[]; light?: number; glow?: "layer" | "baked" | "none"; fps?: number;
  options?: Record<string, unknown>; frames?: number; zoom?: number;
}

/**
 * The render settings worth recording beside the FX record (its `render`, JSON) so check_fx can re-render what
 * was placed: only those that differ from the effect's defaults; undefined when none do.
 */
export function renderRecord(e: FxEntry, input: FxPlaceInput): string | undefined {
  const r: Record<string, unknown> = {};
  if (input.seed !== undefined && input.seed !== e.seed) r.seed = input.seed;
  if (input.flip) r.flip = true;
  if (input.angle && input.angle % 360) r.angle = input.angle;
  if (input.options && Object.keys(input.options).length) r.options = input.options;
  if (Array.isArray(input.palette)) r.palette = input.palette;
  if (input.light !== undefined) r.light = input.light;
  return Object.keys(r).length ? JSON.stringify(r) : undefined;
}

/** preview_fx's contact sheet for an effect (a library entry or a compiled recipe). Nothing changes. */
export function previewFx(e: FxEntry, input: FxPlaceInput): ToolResult {
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input as Parameters<typeof effectOptions>[1]); } catch (err) { return failure((err as Error).message); }
  const fps = input.fps ?? e.fps;
  const r = renderFx(e.module, opts, { fps, seed: input.seed ?? e.seed });
  const total = r.frames.length, want = Math.min(total, input.frames ?? 24);
  const picks = want >= total ? r.frames.map((_, i) => i)
    : Array.from({ length: want }, (_, i) => Math.round((i * (total - 1)) / Math.max(1, want - 1)));
  const box = unionBounds(picks.map((i) => r.frames[i]));
  if (!box) return { content: [text(`${e.id} draws nothing with these options.`)] };
  const shown = picks.map((i) => crop(r.frames[i], box));
  const zoom = input.zoom ?? (box.w <= 64 ? 3 : box.w <= 160 ? 2 : 1);
  const columns = Math.max(1, Math.min(shown.length, Math.floor(1200 / (box.w * zoom + 4))));
  const sheet = contactSheet(shown, { labels: picks.map((i) => String(i + 1)), columns, zoom, background: BACKDROP, labelColor: LABEL });
  const ms = (i: number) => Math.round((i * 1000) / fps);
  const seed = input.seed ?? e.seed;
  const center = fxAnchorPoint(e, "center", opts, seed, fxCanvas(e, false, 0));
  const endsEmpty = !bounds(r.frames[total - 1], 1);
  return {
    content: [
      { type: "image", data: encodePng(sheet).toString("base64"), mimeType: "image/png" },
      text(`${summary(e)}. ${total} frames at ${fps} fps; showing ${shown.length} (frame numbers above each, ` +
        `times ${picks.slice(0, 6).map(ms).join(", ")}${picks.length > 6 ? ", …" : ""} ms), cut to x ${box.x}-${box.x + box.w - 1}, ` +
        `y ${box.y}-${box.y + box.h - 1} of the canvas; the origin (ground) is at ${r.origin.x},${r.origin.y}, the visual ` +
        `centre at ${center.x},${center.y}; add_fx puts its ${e.anchor === "center" ? "centre" : "origin"} at x, y by default (anchor ${e.anchor}). ` +
        `${e.loop ? "It loops." : endsEmpty ? "A one-shot: its last frame is empty." : "A one-shot, but its last frame is not empty (it pops off)."} Zoom ${zoom}.`),
    ],
  };
}

/**
 * add_fx's work for an effect (a library entry or a compiled recipe): render it at the sprite frames' times, place
 * it by its anchor and write it, its glow, its colors and its FX record in one put_images request (one undo step).
 * extra.recipe is the recipe JSON recorded with it.
 */
export async function placeFx(ctx: ToolContext, e: FxEntry, input: FxPlaceInput, extra: { recipe?: string } = {}): Promise<ToolResult> {
  const doc = documentOf(ctx);
  const info = await doc.info();
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input as Parameters<typeof effectOptions>[1]); } catch (err) { return failure((err as Error).message); }
  let snap: RGBA[] | undefined;
  if (input.palette === "sprite") {
    snap = info.palette;
    if (!snap.length) return failure("The sprite palette has no colors to snap to.");
  }
  let ax = Math.floor(info.width / 2), ay = Math.floor(info.height / 2);
  if (input.slice) {
    const s = info.slices.find((x) => x.name === input.slice);
    if (!s) return failure(`No slice named ${input.slice}. Slices: ${info.slices.map((x) => x.name).join(", ") || "none"}.`);
    ax = s.bounds.x + Math.floor(s.bounds.w / 2);
    ay = s.bounds.y + Math.floor(s.bounds.h / 2);
  }
  ax = input.x ?? ax;
  ay = input.y ?? ay;
  const start = input.start_frame ?? info.frame;
  if (start > info.durations.length) return failure(`start_frame ${start} is past the last frame (${info.durations.length}).`);
  const fps = input.fps ?? e.fps;
  const newMs = Math.max(1, Math.round(1000 / fps));
  const plan = fxSchedule(info.durations, start, e.durationMs, e.loop, newMs);
  const canvas = fxCanvas(e, !!input.flip, input.angle ?? 0);
  const seed = input.seed ?? e.seed;
  const r: RenderedFx = renderFx(e.module, opts, { times: plan.samples.map((s) => s.t / 1000), seed, palette: snap, canvas });
  const glow = input.glow ?? "layer";
  const main = freeLayerName(info, e.id);
  const anchor: FxAnchor = input.anchor ?? e.anchor;
  const at = fxAnchorPoint(e, anchor, opts, seed, canvas);
  const left = ax - at.x, top = ay - at.y;
  const colorItems: PutImagesItem[] = [], glowItems: PutImagesItem[] = [];
  plan.samples.forEach((s, i) => {
    const c = placed(glow === "baked" ? r.frames[i] : r.color[i], left, top, info.width, info.height);
    if (c) colorItems.push({ image: c.image, x: c.x, y: c.y, frame: s.frame, newLayer: main });
    if (glow !== "layer") return;
    const g = placed(r.glow[i], left, top, info.width, info.height);
    if (g) glowItems.push({ image: g.image, x: g.x, y: g.y, frame: s.frame, newLayer: `${main} glow`, blendMode: "addition" });
  });
  if (colorItems.length) for (const g of glowItems) g.above = `AI: ${main}`;
  if (!colorItems.length && !glowItems.length) {
    return failure(`${e.id} at ${ax},${ay} lands outside the ${info.width}x${info.height} sprite; nothing was added.`);
  }
  const { append, note: paletteNote } = await fxPalette(doc, info, colorItems, input.palette);
  const res = await doc.putImages([...colorItems, ...glowItems], {
    frames: plan.frames, duration: newMs, label: `Add effect ${e.id}`, prompt: `add_fx ${e.id}`, palette: append,
    // What export needs (#71): the origin in sprite pixels, timing and windup, on the effect's layer.
    fx: {
      layer: colorItems.length ? `AI: ${main}` : `AI: ${main} glow`, id: e.id, x: left + canvas.x, y: top + canvas.y,
      fps, loop: e.loop, windupMs: fxImpact(e, opts, seed, canvas).ms, ...fxSource(e, input, extra),
    },
  });
  const first = plan.samples[0].frame, last = plan.samples.at(-1)!.frame;
  const layerNames = res.layers.map((l) => (l.name.endsWith(" glow") ? `${l.name} (Addition)` : l.name));
  const where = anchor === "center" ? `its visual centre at ${ax},${ay} (anchor center)` : `its origin at ${ax},${ay} (anchor ground)`;
  return {
    content: [text(
      `Added ${e.title} (${e.id}) with ${where} on frames ${first}-${last}` +
      `${res.added ? ` (${res.added} frame${res.added === 1 ? "" : "s"} added, ${newMs} ms each)` : ""}` +
      `${e.loop ? ", looping" : ""}. Layers: ${layerNames.join(", ")}.${paletteNote} One undo step.`,
    )],
  };
}

/** The FX record's optional source fields: the recipe JSON and the render settings that differ from the defaults. */
function fxSource(e: FxEntry, input: FxPlaceInput, extra: { recipe?: string }): { recipe?: string; render?: string } {
  const render = renderRecord(e, input);
  return { ...(extra.recipe ? { recipe: extra.recipe } : {}), ...(render ? { render } : {}) };
}

/** new_fx_sprite's work for an effect (a library entry or a compiled recipe): its own sprite, tagged, one layer with its FX record. */
export async function fxSprite(ctx: ToolContext, e: FxEntry, input: FxPlaceInput, extra: { recipe?: string } = {}): Promise<ToolResult> {
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input as Parameters<typeof effectOptions>[1]); } catch (err) { return failure((err as Error).message); }
  const fps = input.fps ?? e.fps;
  const r = renderFx(e.module, opts, { fps, seed: input.seed ?? e.seed });
  const duration = Math.max(1, Math.round(1000 / fps));
  // The sprite's palette is the effect's colors; past FX_PALETTE_CAP they are reduced and the frames snapped.
  let frames = r.frames, palette = fxColors(frames), paletteNote = `its ${palette.length} colors as the palette`;
  if (palette.length > FX_PALETTE_CAP) {
    const reduced = reducedPalette(frames, FX_PALETTE_CAP);
    frames = frames.map((f) => snapToPalette(f, reduced, 1));
    paletteNote = `its ${palette.length} colors reduced to ${reduced.length} and the frames snapped to them (a palette ` +
      `holds ${FX_PALETTE_CAP})`;
    palette = fxColors(frames);
  }
  const name = e.id.replace(/^recipe:/, "");
  const res = await documentOf(ctx).createAnimation(r.width, r.height, frames.map((image) => ({ image, duration })), {
    title: name, tags: [{ name, from: 1, to: frames.length }], palette,
    fx: {
      id: e.id, x: r.origin.x, y: r.origin.y, fps, loop: e.loop, windupMs: fxImpact(e, opts, input.seed ?? e.seed, fxCanvas(e, false, 0)).ms,
      ...fxSource(e, input, extra),
    },
  });
  const ending = e.loop ? ", a seamless loop" : bounds(frames[frames.length - 1], 1) ? ", a one-shot whose last frame is not empty" : ", a one-shot ending on an empty frame";
  return { content: [text(`Made "${res.title}": ${frames.length} frames of ${r.width}x${r.height} at ${fps} fps (${duration} ms each), ` +
    `tag ${name}${ending}, ${paletteNote}; the effect's origin is at ${r.origin.x},${r.origin.y}.`)] };
}
