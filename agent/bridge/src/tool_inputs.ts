// Tool inputs several tool modules share (beside the document module): a
// frame spec, an image source (a PNG file, the sprite, a layer or the
// selection) and a palette by name. One schema and one resolver each, so
// every tool reads them the same way.
import * as z from "zod/v4";
import type { RGBA } from "./color.js";
import type { Document } from "./document.js";
import { readPng, type Rgba } from "./image.js";
import { resolveNamedPalette } from "./palettes.js";

/**
 * Frames as agents write them: a number (3), a list ([1, 2]), a range
 * ("1-4") or "all". The grammar and range checks are document.resolveFrames
 * (protocol.json params.frames); Document.frames() resolves a spec against
 * the active sprite.
 */
export const framesSpec = z.union([z.string(), z.number().int(), z.array(z.number().int())]);

/** An optional frames input, described with its default (e.g. "all frames", "the active frame"). */
export const framesInput = (fallback: string) =>
  framesSpec.optional().describe(`Frames: 3, [1,2], '1-4' or 'all'. Default: ${fallback}.`);

/**
 * One image or set of colors to read: a PNG file (e.g. an attachment), the
 * sprite (all visible layers), a layer, or the selection.
 */
export const imageSource = z.object({
  source: z.enum(["sprite", "layer", "selection", "file"]).optional()
    .describe("Default 'file' when a path is given, else 'layer' when a layer is given, else 'sprite' (all visible layers). 'file' reads an image path, e.g. an attachment."),
  path: z.string().optional().describe("Image file (PNG) for source 'file', e.g. an attachment."),
  layer: z.string().optional().describe("Layer id like 'L3' or name (source 'layer', or limits 'selection')."),
  frames: framesInput("all for colors; the active frame for one image (the first of these)"),
  frame: z.number().int().min(1).optional().describe("The frame to read. Default: the first of frames, else the active one."),
});
export type ImageSource = z.infer<typeof imageSource>;
export type SourceKind = NonNullable<ImageSource["source"]>;

export const NOT_PNG_SOURCE = "Only PNG files can be read; attach the image as PNG";

/** What a source reads: the explicit source, else a path means a file and a layer means that layer. */
export function sourceKind(src: ImageSource): SourceKind {
  if (src.source) return src.source;
  if (src.path) return "file";
  return src.layer ? "layer" : "sprite";
}

/** The source in words: the path, "the selection", "layer X" or "the sprite". */
export function describeSource(src: ImageSource): string {
  const kind = sourceKind(src);
  if (kind === "file") return src.path ?? "the image";
  if (kind === "selection") return "the selection";
  if (kind === "layer" && src.layer) return `layer ${src.layer}`;
  return "the sprite";
}

/** The layer a sprite source reads ('layer' and 'selection'); undefined means every visible layer. */
export function sourceLayer(src: ImageSource): string | undefined {
  const kind = sourceKind(src);
  return kind === "layer" || kind === "selection" ? src.layer : undefined;
}

/** The frames whose colors a source covers (a frame spec; undefined means all). */
export function sourceFrames(src: ImageSource): unknown {
  return src.frames ?? src.frame;
}

export interface SourceImage {
  image: Rgba;
  /** The source in words (describeSource). */
  description: string;
  /** Where the image's top-left is in the sprite (the selection's corner; else 0, 0). */
  x: number;
  y: number;
  /** The sprite frame it was read from; undefined for a file or the active frame. */
  frame?: number;
}

/**
 * The source as one image: the PNG file, or the layer (or every visible
 * layer) in one frame, cut to the selection's bounds for 'selection'.
 */
export async function readSource(src: ImageSource, doc: Document): Promise<SourceImage> {
  const kind = sourceKind(src);
  const description = describeSource(src);
  if (kind === "file") {
    if (!src.path) throw new Error("source 'file' needs a path");
    const img = readPng(src.path, NOT_PNG_SOURCE);
    return { image: { width: img.width, height: img.height, data: new Uint8Array(img.data) }, description, x: 0, y: 0 };
  }
  const frame = src.frame ?? (src.frames !== undefined ? (await doc.frames(src.frames))[0] : undefined);
  const image = await doc.pixels(sourceLayer(src), frame);
  if (kind === "selection") {
    // Like collect_colors: no selection means the whole image.
    const sel = (await doc.info()).selection;
    if (sel) return { ...cropTo(image, sel), description, frame };
  }
  return { image, description, x: 0, y: 0, frame };
}

function cropTo(img: Rgba, r: { x: number; y: number; w: number; h: number }): { image: Rgba; x: number; y: number } {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const w = Math.max(0, Math.min(img.width, r.x + r.w) - x0), h = Math.max(0, Math.min(img.height, r.y + r.h) - y0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { image: { width: w, height: h, data }, x: x0, y: y0 };
}

/**
 * A palette by name: undefined for 'none' (or nothing), the sprite palette's
 * colors (transparent entries skipped) for 'sprite', else a known palette (Lospec ones fetched on demand, see palettes.ts).
 * Throws for a name no known palette has.
 */
export async function resolvePalette(spec: string | undefined, doc: Document): Promise<RGBA[] | undefined> {
  if (spec === undefined || spec === "" || spec === "none") return undefined;
  if (spec === "sprite") return (await doc.palette()).filter((c) => c.a > 0);
  return (await resolveNamedPalette(spec)).colors;
}
