// Concept-first (#79): what can be measured, without a model, from a concept sheet or storyboard an image model
// made. The panels are found and scaled to the target canvas, each panel's silhouette is measured in target
// pixels, the dominant colors get guessed roles, and a reference and the drawn art are compared by silhouette.
// The tools in concept_tools.ts put these on the sprite; the concept skill tells the agent how to use them.
//
// The idea of splitting design (an image model) from pixel work (the agent), and of a pixel spec written from the
// reference, comes from aseprite-ai-artist (MIT, https://github.com/with-pebbly/aseprite-ai-artist,
// skills/concept/SKILL.md, docs/adr/0009-concept-first.md); the code is our own.
import { hex, hueName, quantize, toOklch, type RGBA } from "./color.js";
import { bounds, OPAQUE, type Rgba } from "./image.js";
import { resample } from "./pixel_grid.js";
import { describeBackground, detectBackground, findSprites, removeBackground, type Rect } from "./sheet.js";
import { countColors } from "./style.js";

/** How the image is cut into panels: a grid of equal panels, or "auto" (sprites counted per row). */
export type PanelLayout = { cols: number; rows: number } | "auto";
/** How a panel is scaled to the target: the dominant color per target pixel ("snap") or the middle pixel ("nearest"). */
export type FitMethod = "snap" | "nearest";
/** An inclusive box in target pixels: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];
export type Point = [number, number];

export interface Storyboard {
  /** The image with its background made transparent. */
  clean: Rgba;
  /** The background in words (describeBackground). */
  background: string;
  cols: number;
  rows: number;
  /** One rect per panel, in reading order (rows top to bottom, left to right). */
  panels: Rect[];
}

/**
 * The image's panels: equal cells of a cols x rows grid (the layout the concept prompt asks for). "auto" counts the
 * sprites on the image (after removing the background): the rows they form and the most sprites in one row. Throws
 * when nothing is left after the background is removed.
 */
export function readStoryboard(img: Rgba, layout: PanelLayout = "auto"): Storyboard {
  const bg = detectBackground(img);
  const clean = removeBackground(img, undefined, bg);
  if (!bounds(clean)) throw new Error("The image has no art left after removing its background.");
  let cols: number, rows: number;
  if (layout === "auto") {
    // Parts of one figure (a sword, a foot) join when closer than about a fortieth of the image.
    const sprites = findSprites(clean, Math.max(2, Math.round(Math.min(img.width, img.height) / 40)), 8);
    const perRow = new Map<number, number>();
    for (const s of sprites) perRow.set(s.row ?? 0, (perRow.get(s.row ?? 0) ?? 0) + 1);
    rows = Math.max(1, perRow.size);
    cols = Math.max(1, ...perRow.values());
  } else ({ cols, rows } = layout);
  if (cols < 1 || rows < 1 || cols > img.width || rows > img.height) throw new Error(`A ${cols}x${rows} grid does not fit a ${img.width}x${img.height} image.`);
  const panels: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((c * img.width) / cols), y = Math.floor((r * img.height) / rows);
      panels.push({ x, y, w: Math.floor(((c + 1) * img.width) / cols) - x, h: Math.floor(((r + 1) * img.height) / rows) - y });
    }
  }
  return { clean, background: describeBackground(bg), cols, rows, panels };
}

/** A copy of a rect of the image. */
export function crop(img: Rgba, r: Rect): Rgba {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data: out };
}

/**
 * A panel scaled to fit a width x height canvas, keeping its aspect ratio: centered across, standing on the bottom
 * edge (the panel's ground line stays the canvas's). "snap" takes each target pixel's dominant color, as pixel snap
 * does (pixel_grid.resample); "nearest" its middle source pixel. Alpha becomes 0 or 255.
 */
export function fitPanel(panel: Rgba, width: number, height: number, method: FitMethod = "snap"): Rgba {
  const f = Math.min(width / panel.width, height / panel.height);
  const sw = Math.max(1, Math.min(width, Math.round(panel.width * f))), sh = Math.max(1, Math.min(height, Math.round(panel.height * f)));
  const scaled = new Uint8Array(sw * sh * 4);
  if (method === "snap") {
    const r = resample(panel, { cellX: 1 / f, cellY: 1 / f, offsetX: 0, offsetY: 0, confidence: 1 });
    for (let y = 0; y < Math.min(sh, r.height); y++) {
      scaled.set(r.data.subarray(y * r.width * 4, (y * r.width + Math.min(sw, r.width)) * 4), y * sw * 4);
    }
  } else {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const sx = Math.min(panel.width - 1, Math.floor((x + 0.5) / f)), sy = Math.min(panel.height - 1, Math.floor((y + 0.5) / f));
        const i = (sy * panel.width + sx) * 4;
        if (panel.data[i + 3] >= OPAQUE) scaled.set([panel.data[i], panel.data[i + 1], panel.data[i + 2], 255], (y * sw + x) * 4);
      }
    }
  }
  const out = new Uint8Array(width * height * 4);
  const ox = Math.floor((width - sw) / 2), oy = height - sh;
  for (let y = 0; y < sh; y++) out.set(scaled.subarray(y * sw * 4, (y + 1) * sw * 4), ((oy + y) * width + ox) * 4);
  return { width, height, data: out };
}

/** What one frame's silhouette measures, in target pixels. */
export interface FrameMeasure {
  /** The bounding box, inclusive; null for an empty panel. */
  bounds: Box | null;
  /** The middle of the bounding box. */
  center: Point | null;
  /** The middle of the top row's pixels (the head, a hat's tip) and of the bottom row's (where it stands). */
  top: Point | null;
  feet: Point | null;
  /** Opaque pixels. */
  pixels: number;
}

/** The silhouette of an image (alpha >= 128): bounds, center, top and feet. */
export function measure(img: Rgba): FrameMeasure {
  const b = bounds(img);
  if (!b) return { bounds: null, center: null, top: null, feet: null, pixels: 0 };
  const rowMid = (y: number): Point => {
    let sum = 0, n = 0;
    for (let x = b.x; x < b.x + b.w; x++) if (img.data[(y * img.width + x) * 4 + 3] >= OPAQUE) { sum += x; n++; }
    return [Math.round(sum / n), y];
  };
  let pixels = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= OPAQUE) pixels++;
  const x1 = b.x + b.w - 1, y1 = b.y + b.h - 1;
  return { bounds: [b.x, b.y, x1, y1], center: [(b.x + x1) / 2, (b.y + y1) / 2], top: rowMid(b.y), feet: rowMid(y1), pixels };
}

/** A dominant color of the reference and the role it probably plays. */
export interface ColorRole {
  role: string;
  hex: string;
  /** Share of the art's pixels, 0-1. */
  share: number;
}

/**
 * The reference's dominant colors (k-means to at most `max`, colors under 2% dropped) with guessed roles: the
 * darkest as outline when it is dark, the most used as main, a much lighter one as highlight, a much darker one
 * as shadow, the most saturated of the rest as accent, others as secondary. Guesses for the agent to correct.
 */
export function colorRoles(img: Rgba, max = 6): ColorRole[] {
  const colors = quantize(countColors(img), max, "k-means");
  const total = colors.reduce((s, c) => s + c.count, 0);
  if (!total) return [];
  const left = colors.filter((c) => c.count / total >= 0.02).map((c) => ({ c, lch: toOklch(c), role: "" }));
  const take = (pick: (typeof left)[number] | undefined, role: string) => { if (pick) pick.role = role; };
  const free = () => left.filter((x) => !x.role);
  const darkest = [...left].sort((a, b) => a.lch.L - b.lch.L)[0];
  if (darkest && darkest.lch.L < 0.35 && left.length > 1) take(darkest, "outline");
  const main = free().sort((a, b) => b.c.count - a.c.count)[0];
  take(main, "main");
  if (main) {
    take(free().filter((x) => x.lch.L > main.lch.L + 0.12).sort((a, b) => b.lch.L - a.lch.L)[0], "highlight");
    take(free().filter((x) => x.lch.L < main.lch.L - 0.12).sort((a, b) => a.lch.L - b.lch.L)[0], "shadow");
  }
  take(free().filter((x) => x.lch.C > 0.08).sort((a, b) => b.lch.C - a.lch.C)[0], "accent");
  let n = 0;
  for (const x of free()) x.role = n++ === 0 ? "secondary" : `secondary ${n}`;
  return left.sort((a, b) => b.c.count - a.c.count).map((x) => ({ role: x.role, hex: hex(x.c as RGBA), share: x.c.count / total }));
}

/** A color's hue in words, for the summary ("red", "neutral"). */
export function colorName(h: string): string {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const lch = toOklch({ r, g, b, a: 255 });
  return lch.C < 0.03 ? (lch.L < 0.3 ? "near-black" : lch.L > 0.85 ? "near-white" : "gray") : hueName(lch.h);
}

/** Everything concept_spec and storyboard_to_frames measure from one image. */
export interface ConceptReading {
  storyboard: Storyboard;
  /** Each panel fitted to the target, in reading order. */
  images: Rgba[];
  frames: FrameMeasure[];
  roles: ColorRole[];
}

/** Reads the panels, fits each to width x height and measures it; the color roles come from the whole image. */
export function readConcept(img: Rgba, width: number, height: number, layout: PanelLayout = "auto", method: FitMethod = "snap"): ConceptReading {
  const storyboard = readStoryboard(img, layout);
  const images = storyboard.panels.map((r) => fitPanel(crop(storyboard.clean, r), width, height, method));
  return { storyboard, images, frames: images.map(measure), roles: colorRoles(storyboard.clean) };
}

/**
 * The pixel spec skeleton (JSON-ready): what was measured, and nulls and empty strings for what only looking can
 * tell (poses, eyes, hands, a weapon's tip, deliberate deviations). Coordinates are target pixels.
 */
export function specSkeleton(r: ConceptReading, o: { path: string; width: number; height: number; imageSize: [number, number] }): Record<string, unknown> {
  const s = r.storyboard;
  const panel = s.panels[0];
  return {
    version: 1,
    canvas: [o.width, o.height],
    source: {
      path: o.path, size: o.imageSize, panels: s.panels.length, grid: [s.cols, s.rows], panelSize: [panel.w, panel.h], background: s.background,
    },
    frames: r.frames.map((f, i) => ({
      panel: i + 1,
      pose: "",
      bounds: f.bounds,
      center: f.center,
      landmarks: { top: f.top, feet: f.feet, eyes: null, hands: null, weapon_tip: null },
    })),
    palette: Object.fromEntries(r.roles.map((c) => [c.role, c.hex])),
    deviations: [],
  };
}

/** Parses a pixel spec given as JSON text or an object; throws a message for the agent when it is not an object. */
export function parseSpec(spec: unknown): Record<string, unknown> {
  let v = spec;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch (e) {
      throw new Error(`The pixel spec is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("A pixel spec is a JSON object (canvas, frames, palette, deviations, ...).");
  return v as Record<string, unknown>;
}

/** The most text a stored pixel spec may have (protocol.json put_images spec). */
export const SPEC_MAX = 65536;

/** A region where the reference and the art disagree: "missing" is reference without art, "extra" art without reference. */
export interface Mismatch {
  frame: number;
  kind: "missing" | "extra";
  pixels: number;
  bounds: Box;
}

/**
 * The regions where two silhouettes (alpha >= 128) differ: 8-connected areas of reference-only pixels ("missing")
 * and of art-only pixels ("extra"), largest first.
 */
export function mismatchRegions(ref: Rgba, art: Rgba, frame: number): Mismatch[] {
  const w = ref.width, h = ref.height;
  const on = (img: Rgba, i: number) => img.data[i * 4 + 3] >= OPAQUE;
  // 1 = missing, 2 = extra, 0 = same.
  const kind = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = on(ref, i), b = i < art.width * art.height && on(art, i);
    kind[i] = a && !b ? 1 : b && !a ? 2 : 0;
  }
  const seen = new Uint8Array(w * h);
  const out: Mismatch[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!kind[start] || seen[start]) continue;
    const k = kind[start];
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (kind[j] === k && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    out.push({ frame, kind: k === 1 ? "missing" : "extra", pixels: n, bounds: [x0, y0, x1, y1] });
  }
  return out.sort((a, b) => b.pixels - a.pixels || a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
}

/** How well two silhouettes agree: intersection over union (0-1) and how far the art's center is from the reference's. */
export function silhouetteMatch(ref: Rgba, art: Rgba): { iou: number; ref: FrameMeasure; art: FrameMeasure; dx?: number; dy?: number } {
  let both = 0, either = 0;
  for (let i = 3; i < ref.data.length; i += 4) {
    const a = ref.data[i] >= OPAQUE, b = (art.data[i] ?? 0) >= OPAQUE;
    if (a && b) both++;
    if (a || b) either++;
  }
  const r = measure(ref), a = measure(art);
  const d = r.center && a.center ? { dx: a.center[0] - r.center[0], dy: a.center[1] - r.center[1] } : {};
  return { iou: either ? both / either : 1, ref: r, art: a, ...d };
}
