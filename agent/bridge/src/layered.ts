// Layered characters from the image generator (#103): a master sheet with the whole character in every key pose,
// then one image per body-part layer drawn from that master (attached as the reference), each holding the part in
// every pose. The sheets share a grid and an image size, so cutting a panel and scaling it to the canvas is the same
// transform for all of them; a small shift per layer panel then fits it inside the master's silhouette.
import type { Aspect, GeneratedImage, ImageGenerator } from "./image_gen.js";
import type { Rgba } from "./image.js";

/** A body-part layer: its name (the layer's name) and how the image model is told which part it is. */
export interface PartLayer {
  name: string;
  part: string;
}

/**
 * The default rough layers, bottom to top (the draw order): far limbs under the torso, near limbs over it. "Near" is
 * the side toward the viewer. walk_check reads "near arm" and "near leg".
 */
export const DEFAULT_LAYERS: PartLayer[] = [
  { name: "far arm", part: "the far arm (the arm on the side away from the viewer, behind the body), with its hand" },
  { name: "far leg", part: "the far leg (the leg on the side away from the viewer), with its foot" },
  { name: "torso", part: "the torso (chest, belly and hips, with the clothes on them), without arms, legs or head" },
  { name: "near leg", part: "the near leg (the leg on the viewer's side), with its foot" },
  { name: "head", part: "the head and face (skin, ears, nose, mouth), without the hair and without the eyes" },
  { name: "eyes", part: "the eyes (and eyebrows) only" },
  { name: "hair", part: "the hair (or helmet or hat) only" },
  { name: "near arm", part: "the near arm (the arm on the viewer's side, in front of the body), with its hand" },
];

export interface Grid {
  cols: number;
  rows: number;
  aspect: Aspect;
}

/** A grid of square panels for `n` poses: 1, 2x1... up to 3x3, on a square or landscape image. */
export function gridFor(n: number): Grid {
  if (n < 1 || n > 9) throw new Error(`A sheet holds 1 to 9 poses, not ${n}.`);
  if (n === 1) return { cols: 1, rows: 1, aspect: "square" };
  if (n <= 4) return { cols: 2, rows: 2, aspect: "square" };
  if (n <= 6) return { cols: 3, rows: 2, aspect: "landscape" };
  return { cols: 3, rows: 3, aspect: "square" };
}

export interface SheetRequest {
  /** What the character is and its style (from the user's request). */
  subject: string;
  /** "side view, facing right", "front view"... */
  view: string;
  /** One line per key pose, in frame order. */
  poses: string[];
  /** An image of the existing character (a snapshot of the sprite) the master must match, if any. */
  reference?: string;
}

const layoutLines = (g: Grid, n: number) => [
  `Layout: exactly ${g.cols * g.rows} equal square panels in a ${g.cols} x ${g.rows} grid filling the image, no gaps, no borders, no numbers.` +
    (n < g.cols * g.rows ? ` Only the first ${n} panels (reading order, left to right, top to bottom) are used; leave the rest plain white.` : ""),
  "Each panel is the whole canvas: the character at the same scale in every panel, centered, the feet on the same ground line near the panel's bottom.",
];

/** The master sheet: the whole character, one key pose per panel. */
export function masterPrompt(r: SheetRequest, g: Grid): string {
  return [
    `Character key-pose sheet for a pixel-art sprite: ${r.subject}.`,
    ...(r.reference ? ["The attached image is this character as it exists: keep its design, colors and proportions exactly."] : []),
    `${r.view}. Full body, flat colors, a clean dark outline, simple shapes that read when small, ` +
      "the near limbs (toward the viewer) clearly lighter than the far limbs.",
    ...layoutLines(g, r.poses.length),
    "Panels:",
    ...r.poses.map((p, i) => `${i + 1}. ${p}`),
    "Plain white background, no ground shadow, no scenery, no text.",
  ].join("\n");
}

/** One layer's sheet: only that part, from the attached master, in every panel, at the same place. */
export function layerPrompt(part: PartLayer, g: Grid, n: number): string {
  return [
    `The attached image is a character sheet: ${n} pose${n > 1 ? "s" : ""} in a ${g.cols} x ${g.rows} grid of square panels.`,
    `Make an image of exactly the same size and the same grid in which each panel shows ONLY ${part.part} of that ` +
      "character, at exactly the same position, size, angle and colors as in that panel of the attached sheet.",
    "Draw the whole part, also where other parts cover it in the attached sheet. Everything else is plain white: " +
      "no other body parts, no outline of the rest of the body, no text, no borders.",
  ].join("\n");
}

export interface LayeredResult {
  master: GeneratedImage;
  layers: { name: string; image?: GeneratedImage; error?: string }[];
}

/**
 * The master first, then every layer from it, `parallel` at a time; a failed layer is tried once more. Fails only
 * when the master fails (nothing can be aligned without it).
 */
export async function generateLayered(
  gen: ImageGenerator, r: SheetRequest, layers: PartLayer[], signal: AbortSignal, parallel = 3,
  progress: (done: number, total: number) => void = () => {},
): Promise<LayeredResult> {
  const g = gridFor(r.poses.length);
  const master = await gen.generate(masterPrompt(r, g), g.aspect, signal, r.reference ? [r.reference] : []);
  const total = layers.length + 1;
  let done = 1;
  progress(done, total);
  const out: LayeredResult["layers"] = layers.map((l) => ({ name: l.name }));
  let next = 0;
  const worker = async () => {
    while (next < layers.length && !signal.aborted) {
      const i = next++;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          out[i].image = await gen.generate(layerPrompt(layers[i], g, r.poses.length), g.aspect, signal, [master.path]);
          out[i].error = undefined;
          break;
        } catch (e) {
          out[i].error = (e as Error).message;
          if (signal.aborted) break;
        }
      }
      progress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, layers.length)) }, worker));
  if (signal.aborted) throw new Error("The layered generation was cancelled.");
  return { master, layers: out };
}

/** Pixels of `part` (alpha >= 128) shifted by dx, dy that land on the master's silhouette, and those that don't. */
function fit(part: Rgba, master: Rgba, dx: number, dy: number): { inside: number; outside: number } {
  let inside = 0, outside = 0;
  for (let y = 0; y < part.height; y++) for (let x = 0; x < part.width; x++) {
    if (part.data[(y * part.width + x) * 4 + 3] < 128) continue;
    const mx = x + dx, my = y + dy;
    if (mx >= 0 && my >= 0 && mx < master.width && my < master.height && master.data[(my * master.width + mx) * 4 + 3] >= 128) inside++;
    else outside++;
  }
  return { inside, outside };
}

/**
 * The shift (within ±max px) that puts the most of a layer panel inside the master panel's silhouette, ties to the
 * smallest shift, and the share of the part still outside it (a misaligned layer stays well above 0).
 */
export function alignToMaster(part: Rgba, master: Rgba, max = 3): { dx: number; dy: number; outside: number; pixels: number } {
  let best = { dx: 0, dy: 0, score: -Infinity, outside: 0, pixels: 0 };
  for (let dy = -max; dy <= max; dy++) for (let dx = -max; dx <= max; dx++) {
    const f = fit(part, master, dx, dy);
    const score = f.inside - f.outside - (Math.abs(dx) + Math.abs(dy)) * 0.01;
    if (score > best.score) best = { dx, dy, score, outside: f.outside, pixels: f.inside + f.outside };
  }
  return { dx: best.dx, dy: best.dy, outside: best.pixels ? best.outside / best.pixels : 0, pixels: best.pixels };
}

/** A copy of an image moved by dx, dy (what leaves the canvas is cut). */
export function shifted(img: Rgba, dx: number, dy: number): Rgba {
  if (!dx && !dy) return img;
  const out = new Uint8Array(img.width * img.height * 4);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
    out.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (ny * img.width + nx) * 4);
  }
  return { width: img.width, height: img.height, data: out };
}
