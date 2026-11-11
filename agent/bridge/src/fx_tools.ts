// Pixel FX tools (#69): list the FX library, preview an effect as a labelled contact sheet, add one to the
// active sprite on 'AI: fx <id>' layers (glow on an Addition layer) in one undo step, or make it a sprite.
// Placement and the FX record live in the FX domain module (fx/place.ts, fx/record.ts, #97).
import * as z from "zod/v4";
import type { RGBA } from "./color.js";
import { documentOf } from "./document.js";
import { renderFx } from "./fx/index.js";
import { FX_CATEGORIES, FX_LIBRARY, findFx, searchFx, type FxAnchor, type FxEntry } from "./fx/library.js";
import {
  FX_PALETTE_CAP, fxAnchorPoint, fxColors, fxImpact, fxSchedule, planPlacement, previewPlacement, reducedPalette, writePlacement, type FxSample,
} from "./fx/place.js";
import { buildRecord, effectOptions, fxCanvas, renderRecord, type RenderInput } from "./fx/record.js";
import { bounds, contactSheet, crop, encodePng, snapToPalette, type Rect, type Rgba } from "./image.js";
import { failure, text, type Tool, type ToolContext, type ToolResult } from "./tool.js";

// Moved to the FX domain module (#97); re-exported for callers and tests that import them from here.
export { FX_PALETTE_CAP, fxAnchorPoint, fxColors, fxImpact, fxPalette, fxSchedule, placed, type FxSample } from "./fx/place.js";
export { effectOptions, freeLayerName, fxCanvas, renderRecord } from "./fx/record.js";

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

/** add_fx's and fx_overlay's context preview (#97). */
export const previewInput = z.boolean().optional()
  .describe("true: change nothing and return the placement over the sprite's frames as a contact sheet (the same timing, impact, cut, palette, glow and seed as placing it).");

export const anchorInput = z.enum(["center", "ground"]).optional()
  .describe("What x, y means. 'center': the effect's visual centre goes there (the impact point). 'ground': its origin " +
    "(the ground point under a pillar, fire or explosion) goes there. Default: the effect's own (list_fx).");

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
      "Addition blend, 'baked' paints it into the colors, 'none' leaves it out. preview: true shows the placement over the " +
      "sprite's frames instead (nothing changes).",
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
      preview: previewInput,
    }),
    kind: "edit",
    label: (a) => (a?.preview ? `Preview effect ${a?.id ?? ""} on the sprite`.trim() : a?.id ? `Add effect ${a.id}` : "Add effect"),
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
export interface FxPlaceInput extends RenderInput {
  x?: number; y?: number; anchor?: FxAnchor; slice?: string; start_frame?: number;
  palette?: "sprite" | string[]; glow?: "layer" | "baked" | "none"; fps?: number;
  frames?: number; zoom?: number;
  /** add_fx: show the placement over the sprite instead of writing it (a context preview). */
  preview?: boolean;
}

/** preview_fx's contact sheet for an effect (a library entry or a compiled recipe). Nothing changes. */
export function previewFx(e: FxEntry, input: FxPlaceInput): ToolResult {
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input); } catch (err) { return failure((err as Error).message); }
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
 * add_fx's work for an effect (a library entry or a compiled recipe): plan the destination timing (the sprite
 * frames' times from start_frame), then the FX domain module places, cuts and records it (planPlacement) and writes
 * it with its glow, colors and FX record in one put_images request (one undo step), or, with preview, shows that
 * same placement over the sprite. extra.recipe is the recipe JSON recorded with it.
 */
export async function placeFx(ctx: ToolContext, e: FxEntry, input: FxPlaceInput, extra: { recipe?: string } = {}): Promise<ToolResult> {
  const doc = documentOf(ctx);
  const info = await doc.info();
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input); } catch (err) { return failure((err as Error).message); }
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
  const anchor: FxAnchor = input.anchor ?? e.anchor;
  const pl = planPlacement(info, {
    e, opts, render: input, seed: input.seed ?? e.seed, canvas: fxCanvas(e, !!input.flip, input.angle ?? 0), anchor, x: ax, y: ay,
    samples: plan.samples, glow: input.glow ?? "layer", snap, fps, recipe: extra.recipe,
  });
  if (!pl) return failure(`${e.id} at ${ax},${ay} lands outside the ${info.width}x${info.height} sprite; nothing was added.`);
  const first = plan.samples[0].frame, last = plan.samples.at(-1)!.frame;
  const where = anchor === "center" ? `its visual centre at ${ax},${ay} (anchor center)` : `its origin at ${ax},${ay} (anchor ground)`;
  if (input.preview) {
    const added = plan.frames - info.durations.length;
    return { content: [await previewPlacement(doc, info, pl), text(
      `Preview of ${e.title} (${e.id}) with ${where} on frames ${first}-${last}${added ? ` (${added} frame${added === 1 ? "" : "s"} would be added, ${newMs} ms each)` : ""}: ` +
      `effect times ${plan.samples.slice(0, 12).map((s) => Math.round(s.t)).join(", ")}${plan.samples.length > 12 ? ", …" : ""} ms; ` +
      `each frame shows the sprite with the effect as add_fx would place it (same timing, cut, palette, glow and seed). Nothing changed.`)] };
  }
  const { res, paletteNote } = await writePlacement(doc, info, pl, { palette: input.palette, frames: plan.frames, duration: newMs, label: `Add effect ${e.id}`, prompt: `add_fx ${e.id}` });
  const layerNames = res.layers.map((l) => (l.name.endsWith(" glow") ? `${l.name} (Addition)` : l.name));
  return {
    content: [text(
      `Added ${e.title} (${e.id}) with ${where} on frames ${first}-${last}` +
      `${res.added ? ` (${res.added} frame${res.added === 1 ? "" : "s"} added, ${newMs} ms each)` : ""}` +
      `${e.loop ? ", looping" : ""}. Layers: ${layerNames.join(", ")}.${paletteNote} One undo step.`,
    )],
  };
}

/** new_fx_sprite's work for an effect (a library entry or a compiled recipe): its own sprite, tagged, one layer with its FX record. */
export async function fxSprite(ctx: ToolContext, e: FxEntry, input: FxPlaceInput, extra: { recipe?: string } = {}): Promise<ToolResult> {
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, input); } catch (err) { return failure((err as Error).message); }
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
    fx: buildRecord({
      id: e.id, x: r.origin.x, y: r.origin.y, fps, loop: e.loop, windupMs: fxImpact(e, opts, input.seed ?? e.seed, fxCanvas(e, false, 0)).ms,
      recipe: extra.recipe, render: renderRecord(e, input),
    }),
  });
  const ending = e.loop ? ", a seamless loop" : bounds(frames[frames.length - 1], 1) ? ", a one-shot whose last frame is not empty" : ", a one-shot ending on an empty frame";
  return { content: [text(`Made "${res.title}": ${frames.length} frames of ${r.width}x${r.height} at ${fps} fps (${duration} ms each), ` +
    `tag ${name}${ending}, ${paletteNote}; the effect's origin is at ${r.origin.x},${r.origin.y}.`)] };
}
