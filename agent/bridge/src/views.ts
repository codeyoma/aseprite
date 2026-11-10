// Review views for snapshot (#75): a filmstrip of frames, an onion skin of a frame over its tinted neighbors,
// and a reference layer beside the art. A vision model reads only the first frame of a GIF, so motion has to be
// laid out in one still image to be judged. The views are composed here from plain per-frame or per-layer
// snapshots (the document module's pixels), so the wire protocol does not change.
//
// The three views follow the ideas of the `look` tool in aseprite-ai-artist (MIT,
// https://github.com/with-pebbly/aseprite-ai-artist, src/tools/look.ts); the code is our own.
import { documentOf, resolveFrames, type LayerInfo, type SpriteInfo } from "./document.js";
import { composeNormal } from "./export.js";
import { shownImageLayers } from "./export_tools.js";
import { contactSheet, encodePng, flatten, sheetGeometry, type Rgba } from "./image.js";
import { encodeSnapshot } from "./png.js";
import type { RGBA } from "./color.js";
import { failure, text, type AsepriteRequester, type ToolResult } from "./tool.js";

export type View = "filmstrip" | "onion" | "compare";

export interface ViewInput {
  view: View;
  frame?: number;
  layer?: string;
  scale?: number;
  background?: string;
  tag?: string;
  frames?: unknown;
  ghosts?: number;
  reference?: string;
}

/** The long edge a view aims for: large enough to read single pixels, small enough for a vision model. */
export const VIEW_TARGET = 1024;
/** No view is ever larger than this on either side, whatever scale is asked for. */
export const VIEW_MAX = 2048;
/** The gaps between sheet cells, and the label color. */
export const SHEET_BACKDROP: RGBA = { r: 32, g: 32, b: 40, a: 255 };
export const SHEET_LABEL: RGBA = { r: 240, g: 240, b: 240, a: 255 };
/** Onion ghost tints: earlier frames red, later frames blue, as Aseprite's red/blue onion skin. */
export const GHOST_BEFORE: RGBA = { r: 255, g: 48, b: 48, a: 255 };
export const GHOST_AFTER: RGBA = { r: 48, g: 96, b: 255, a: 255 };
/** Ghost opacity by distance from the target frame (1 = the next or previous frame). */
export const GHOST_ALPHA = [96, 64, 40];

export interface FilmstripLayout {
  zoom: number;
  columns: number;
  /** How many frames fit (the first ones); fewer than asked only when even zoom 1 is too large. */
  shown: number;
  width: number;
  height: number;
}

/**
 * The filmstrip's zoom and columns for n frames of w x h: the largest zoom (from `scale`, else one that makes a
 * frame about 256 px, at most 16) whose sheet fits in VIEW_TARGET px each way, wrapping into balanced rows when
 * one row is too wide. An explicit scale may grow the sheet up to VIEW_MAX. When even zoom 1 does not fit in
 * VIEW_MAX, only the first frames that do are shown.
 */
export function filmstripLayout(n: number, w: number, h: number, scale?: number): FilmstripLayout {
  const fit = (z: number, max: number, count: number) => {
    const one = sheetGeometry(1, w, h, { columns: 1, zoom: z });
    let columns = Math.max(1, Math.min(count, Math.floor((max - one.gap) / (one.cellW + one.gap))));
    columns = Math.ceil(count / Math.ceil(count / columns)); // balance the rows
    const g = sheetGeometry(count, w, h, { columns, zoom: z });
    return g.width <= max && g.height <= max ? { zoom: g.zoom, columns: g.columns, shown: count, width: g.width, height: g.height } : undefined;
  };
  const max = scale ? VIEW_MAX : VIEW_TARGET;
  const start = scale ?? Math.max(1, Math.min(16, Math.floor(256 / Math.max(w, h))));
  for (let z = start; z >= 1; z--) {
    const l = fit(z, max, n);
    if (l) return l;
  }
  for (let count = n; count >= 1; count--) {
    const l = fit(1, VIEW_MAX, count);
    if (l) return l;
  }
  const g = sheetGeometry(1, w, h, { columns: 1, zoom: 1 });
  return { zoom: 1, columns: 1, shown: 1, width: g.width, height: g.height };
}

/**
 * A ghost of a frame for the onion skin: each pixel's color mixed 60% toward the tint, its alpha scaled by
 * alpha/255.
 */
export function ghost(img: Rgba, tint: RGBA, alpha: number): Rgba {
  const d = new Uint8Array(img.data);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    d[i] = Math.round(d[i] * 0.4 + tint.r * 0.6);
    d[i + 1] = Math.round(d[i + 1] * 0.4 + tint.g * 0.6);
    d[i + 2] = Math.round(d[i + 2] * 0.4 + tint.b * 0.6);
    d[i + 3] = Math.round((d[i + 3] * alpha) / 255);
  }
  return { width: img.width, height: img.height, data: d };
}

/**
 * The onion skin: the ghosts (farthest first, each [image, distance, before?]) blended under the target frame,
 * which is drawn at full opacity on top. Transparent where nothing is drawn.
 */
export function onionSkin(target: Rgba, ghosts: { image: Rgba; distance: number; before: boolean }[]): Rgba {
  const layers = [...ghosts].sort((a, b) => b.distance - a.distance).map((g) => ({
    image: ghost(g.image, g.before ? GHOST_BEFORE : GHOST_AFTER, 255),
    opacity: GHOST_ALPHA[Math.min(GHOST_ALPHA.length, g.distance) - 1],
  }));
  return composeNormal([...layers, { image: target, opacity: 255 }], target.width, target.height);
}

/**
 * The neighbors of `frame` for the onion skin, nearest first: `count` before and after. Inside a looping range
 * (a tag) they wrap around it; otherwise they stop at the first and last frame.
 */
export function onionNeighbors(frame: number, count: number, first: number, last: number, wrap: boolean) {
  const out: { frame: number; distance: number; before: boolean }[] = [];
  const span = last - first + 1;
  for (let d = 1; d <= count; d++) {
    for (const before of [true, false]) {
      let f = frame + (before ? -d : d);
      if (wrap) f = first + ((((f - first) % span) + span) % span);
      if (f < first || f > last || f === frame) continue;
      if (out.some((o) => o.frame === f)) continue;
      out.push({ frame: f, distance: d, before });
    }
  }
  return out;
}

/** The snapshot's background for a view: the checker (squares of `cell` sprite pixels) or a solid color. */
function backgroundOf(background: string | undefined): RGBA | "checker" | undefined {
  if (!background || background === "checker") return "checker";
  if (background === "transparent") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(background);
  if (!m) throw new Error(`Invalid background color: ${background}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
}

/** Frames over the view's background (a checker of about 4 sheet pixels), ready for a contact sheet. */
function onBackground(frames: Rgba[], background: string | undefined, zoom: number): Rgba[] {
  const bg = backgroundOf(background);
  if (!bg) return frames;
  return frames.map((f) => flatten(f, bg, Math.max(1, Math.ceil(4 / zoom))));
}

const image = (img: Rgba) => ({ type: "image" as const, data: encodePng(img).toString("base64"), mimeType: "image/png" });

/** The frames a filmstrip shows: a tag's frames, a frames spec, or every frame. */
export function filmstripFrames(info: SpriteInfo, input: { tag?: string; frames?: unknown }, resolve: (spec: unknown) => number[]): number[] {
  if (input.tag !== undefined) {
    const t = findTag(info, input.tag);
    return Array.from({ length: t.to - t.from + 1 }, (_, i) => t.from + i);
  }
  return resolve(input.frames ?? "all");
}

/** A tag by name (exact first, then ignoring case); throws with the tag list when there is none. */
function findTag(info: SpriteInfo, name: string) {
  const t = info.tags.find((x) => x.name === name) ?? info.tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t) throw new Error(`No tag named "${name}" (tags: ${info.tags.map((x) => x.name).join(", ") || "none"})`);
  return t;
}

/** A layer by id ("L3") or name, for compare. */
function findLayer(info: SpriteInfo, ref: string): LayerInfo | undefined {
  return info.layers.find((l) => l.id === ref) ?? info.layers.find((l) => l.name === ref) ??
    info.layers.find((l) => l.name.toLowerCase() === ref.toLowerCase());
}

/** snapshot with `view`: compose the view from per-frame or per-layer snapshots. Nothing changes. */
export async function snapshotView(aseprite: AsepriteRequester, input: ViewInput): Promise<ToolResult> {
  const doc = documentOf(aseprite);
  const info = await doc.info();
  const { width: w, height: h } = info;
  const n = info.durations.length;

  if (input.view === "filmstrip") {
    const frames = filmstripFrames(info, input, (spec) => resolveFrames(spec, n, info.frame, "all"));
    return filmstrip(doc, info, frames, input);
  }

  if (input.view === "onion") {
    let first = 1, last = n, wrap = false, at = input.frame ?? info.frame;
    if (input.tag !== undefined) {
      // Inside a tag the neighbors wrap, as the animation loops; the target defaults to the tag's first frame.
      const t = findTag(info, input.tag);
      if (input.frame !== undefined && (at < t.from || at > t.to)) return failure(`Frame ${at} is not in tag "${t.name}" (${t.from}-${t.to})`);
      if (at < t.from || at > t.to) at = t.from;
      first = t.from; last = t.to; wrap = true;
    }
    if (at < 1 || at > n) return failure(`Frame ${at} is out of range (1-${n})`);
    const near = onionNeighbors(at, input.ghosts ?? 1, first, last, wrap);
    const base = await doc.pixels(input.layer, at);
    const ghosts = await Promise.all(near.map(async (g) => ({ ...g, image: await doc.pixels(input.layer, g.frame) })));
    const skin = onionSkin(base, ghosts);
    const s = Math.max(1, Math.min(input.scale ?? Math.floor(512 / Math.max(w, h)), Math.floor(VIEW_MAX / Math.max(w, h))));
    const png = encodeSnapshot(Buffer.from(skin.data), w, h, s, input.background ?? "checker");
    const list = (before: boolean) => near.filter((g) => g.before === before).map((g) => g.frame).join(", ") || "none";
    return {
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        text(`Onion skin of frame ${at}${input.layer ? `, layer "${input.layer}"` : ""}: ${w}x${h} px shown at ${s}x ` +
          `(${w * s}x${h * s}). Frame ${at} is drawn solid on top; earlier frames (${list(true)}) are ghosted in red and ` +
          `later frames (${list(false)}) in blue underneath, fainter with distance${wrap ? ", wrapping around the tag" : ""}. ` +
          `Look for even spacing between ghost and frame, arcs, and parts that pop.`),
      ],
    };
  }

  // compare: the reference layer on the left, the art without it on the right, same frame and zoom.
  const frame = input.frame ?? info.frame;
  if (frame < 1 || frame > n) return failure(`Frame ${frame} is out of range (1-${n})`);
  const ref = input.reference !== undefined ? findLayer(info, input.reference)
    : info.layers.find((l) => !l.group && /\bref(erence)?\b/i.test(l.name));
  if (!ref) {
    return failure(input.reference !== undefined ? `No layer named "${input.reference}"`
      : "No reference layer found (none is named like 'reference'); pass reference: '<layer name>'.");
  }
  if (ref.group) return failure(`"${ref.name}" is a group; pass the reference image layer.`);
  const refImage = await doc.pixels(ref.id, frame);
  let art: Rgba;
  if (input.layer !== undefined) art = await doc.pixels(input.layer, frame);
  else {
    const others = shownImageLayers(info).filter((l) => l.id !== ref.id);
    if (others.length === shownImageLayers(info).length) art = await doc.pixels(undefined, frame);
    else {
      // Bottom first, as they are composed.
      const layers = await Promise.all([...others].reverse().map(async (l) => ({ image: await doc.pixels(l.id, frame), opacity: l.opacity ?? 255 })));
      art = composeNormal(layers, w, h);
    }
  }
  // Two cells side by side: 12 + 2 * w * zoom wide, 21 + h * zoom high (sheetGeometry's gaps and label strip).
  const fits = (max: number) => Math.max(1, Math.min(Math.floor((max - 12) / (2 * w)), Math.floor((max - 21) / h)));
  const zoom = input.scale ? Math.min(input.scale, fits(VIEW_MAX)) : Math.min(16, fits(VIEW_TARGET));
  const shown = onBackground([refImage, art], input.background, zoom);
  const sheet = contactSheet(shown, { labels: ["REF", "ART"], columns: 2, zoom, background: SHEET_BACKDROP, labelColor: SHEET_LABEL });
  return {
    content: [
      image(sheet),
      text(`Compare, frame ${frame}: left REF is layer "${ref.name}", right ART is ${input.layer ? `layer "${input.layer}"` : "the sprite without it"}` +
        `; ${w}x${h} px each at ${zoom}x (${sheet.width}x${sheet.height}). Name the few largest differences (shape, proportions, ` +
        `colors) and fix those first.`),
    ],
  };
}

async function filmstrip(doc: ReturnType<typeof documentOf>, info: SpriteInfo, frames: number[], input: ViewInput): Promise<ToolResult> {
  const { width: w, height: h } = info;
  const layout = filmstripLayout(frames.length, w, h, input.scale);
  const picked = frames.slice(0, layout.shown);
  const images = [];
  for (const f of picked) images.push(await doc.pixels(input.layer, f));
  const sheet = contactSheet(onBackground(images, input.background, layout.zoom), {
    labels: picked.map(String), columns: layout.columns, zoom: layout.zoom, background: SHEET_BACKDROP, labelColor: SHEET_LABEL,
  });
  const range = picked.length > 1 && picked.every((f, i) => i === 0 || f === picked[i - 1] + 1)
    ? `${picked[0]}-${picked[picked.length - 1]}` : picked.join(", ");
  const durations = picked.map((f) => info.durations[f - 1]);
  const timing = durations.every((d) => d === durations[0]) ? `${durations[0]} ms each` : `durations ${durations.join(", ")} ms`;
  const cut = layout.shown < frames.length
    ? ` Only the first ${layout.shown} of ${frames.length} frames fit; ask for the rest with frames.` : "";
  return {
    content: [
      image(sheet),
      text(`Filmstrip of frames ${range}${input.tag ? ` (tag "${input.tag}")` : ""}${input.layer ? `, layer "${input.layer}"` : ""}: ` +
        `${picked.length} frames of ${w}x${h} px at ${layout.zoom}x, ${layout.columns} per row, ${timing} (${sheet.width}x${sheet.height}). ` +
        `Read left to right, top to bottom; the number above each is its frame. Check that each frame moves on from the ` +
        `last, the silhouette keeps its size, and the loop's last frame leads into the first.${cut}`),
    ],
  };
}
