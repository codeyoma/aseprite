// The shared seam of the sprite effects (#104-#107): read a layer's frames, and write an effect's frames onto a new
// 'AI: <name>' layer in one undo step, with the source layer hidden (the original stays, untouched, under it).
// Two placements:
// - insert: new frames go right after frame `after` (every other layer's cels there are linked to `after`), and the
//   effect fills them;
// - over: the effect replaces existing frames of the copy.
// Every frame the effect does not fill gets a copy of the source's cel, so hiding the source changes nothing there.
import { contactSheet, encodePng, trim, type Rgba } from "../image.js";
import type { Document, FxInfo, PutImagesItem, SpriteInfo } from "../document.js";
import type { Content } from "../tool.js";
import { aiLayer } from "../fx/record.js";

const BACKDROP = { r: 24, g: 24, b: 32, a: 255 }, LABEL = { r: 200, g: 200, b: 210, a: 255 };

/** The image layer a reference names (an id like 'L12' or a name). */
export function imageLayer(info: SpriteInfo, ref: string | undefined) {
  const want = ref ?? info.layerId;
  return info.layers.find((l) => !l.group && (l.id === want || l.id === `L${want}`)) ?? info.layers.find((l) => !l.group && l.name === want);
}

export interface EffectWrite {
  /** The source layer's id. */
  source: string;
  /** The new layer's name without the 'AI: ' prefix. */
  name: string;
  /** insert: frames right after `after`, one per duration (ms). */
  insert?: { after: number; durations: number[] };
  /** The effect's frames, by frame number after the insert. */
  frames: Map<number, Rgba>;
  /** Hex colors the effect adds (appended to the palette in the same undo step). */
  palette?: string[];
  label: string;
  prompt: string;
  /** An FX record for the new layer (an effect pipeline's JSON, #107), written in the same request. */
  fx?: FxInfo;
  /** Layers emptied first in the same request (#97: the effect's own layer when it is re-applied). */
  clear?: string[];
  /** Frame durations to set (numbered after the insert). */
  durations?: { frame: number; ms: number }[];
}

/**
 * Writes an effect: the effect's frames, plus a copy of the source in every other frame, on 'AI: <name>' above the
 * source, which is hidden. One put_images request, so one undo step. Returns the frame count after the write.
 */
export async function writeEffect(doc: Document, info: SpriteInfo, w: EffectWrite): Promise<{ layer: string; frames: number }> {
  const n = info.durations.length, k = w.insert?.durations.length ?? 0, after = w.insert?.after ?? n;
  const total = n + k;
  // Final frame number -> the source frame it copies (frames after the insert move down by k).
  const original = (f: number) => (f <= after ? f : f > after + k ? f - k : after);
  const items: PutImagesItem[] = [];
  const cache = new Map<number, Rgba & { x: number; y: number }>();
  for (let f = 1; f <= total; f++) {
    let img = w.frames.get(f);
    let x = 0, y = 0;
    if (img) {
      const t = trim(img, 1);
      img = t; x = t.x; y = t.y;
    } else {
      const src = original(f);
      if (!cache.has(src)) cache.set(src, trim(await doc.pixels(w.source, src), 1));
      const t = cache.get(src)!;
      img = t; x = t.x; y = t.y;
    }
    if (!img.width || !img.height || (img.width === info.width && img.height === info.height && !hasContent(img))) continue;
    items.push({ image: img, frame: f, x, y, newLayer: w.name, above: w.source });
  }
  if (items.length) items[0].hideSource = true;
  const res = await doc.putImages(items, {
    insert: w.insert ? [{ after: w.insert.after, durations: w.insert.durations }] : undefined,
    label: w.label, prompt: w.prompt, palette: w.palette, clear: w.clear, durations: w.durations,
    fx: w.fx && items.length ? { ...w.fx, layer: aiLayer(w.name) } : undefined,
  });
  return { layer: res.layers[0]?.name ?? aiLayer(w.name), frames: total };
}

function hasContent(img: Rgba): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) return true;
  return false;
}

/** The effect's frames as a numbered contact sheet, cut to where anything draws (with a margin). */
export function effectPreview(frames: Rgba[], labels: string[]): Content | undefined {
  if (!frames.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const f of frames) {
    const t = trim(f, 1);
    if (t.width === f.width && t.height === f.height && !hasContent(f)) continue;
    x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + t.width); y1 = Math.max(y1, t.y + t.height);
  }
  if (x1 < 0) return undefined;
  const W = frames[0].width, H = frames[0].height;
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(W, x1 + 2); y1 = Math.min(H, y1 + 2);
  const cut = frames.map((f) => {
    const w = x1 - x0, h = y1 - y0, out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(f.data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  });
  const w = x1 - x0;
  const zoom = w <= 48 ? 4 : w <= 96 ? 3 : w <= 160 ? 2 : 1;
  const columns = Math.max(1, Math.min(cut.length, Math.floor(1200 / (w * zoom + 4))));
  const sheet = contactSheet(cut, { labels, columns, zoom, background: BACKDROP, labelColor: LABEL });
  return { type: "image", data: encodePng(sheet).toString("base64"), mimeType: "image/png" };
}
