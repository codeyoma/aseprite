// Attachments (#21): images the user attaches in the chat panel. The
// extension renders a selection, layer or frame to a PNG under
// ~/.aseprite-agent/attachments, takes the clipboard image, or the user picks
// an image file; it sends the paths with the message, and the bridge turns
// each into one ACP image block.
//
// Providers take PNG, JPEG, WebP and still GIF. A file in one of those that
// is a sensible size goes as it is. Anything else Aseprite can open (an
// animated GIF, WebP or APNG, BMP, TGA, ICO, PCX, QOI, PSD, FLI or a
// .aseprite file), tiny pixel art and very large images go through
// `aseprite -b --sheet` first: one frame becomes a PNG scaled to a readable
// size, an animation becomes a numbered contact sheet with frame times.
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { contactSheet, crop, decodePng, encodePng, flatten, scale, shrink, type Rgba } from "./image.js";
import { sessionDir } from "./session.js";
import { filmstripLayout, SHEET_BACKDROP, SHEET_LABEL } from "./views.js";

export const attachmentDir = join(sessionDir, "attachments");

/** An attachment as the panel sends it. */
export interface Attachment {
  label: string;
  path: string;
}

/** An image ready for the agent; label says what it shows (size, frames). */
export interface ImageBlock {
  label: string;
  mimeType: string;
  data: string; // base64
}

/** Extensions Aseprite opens; the panel's file picker offers the same list. */
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tga", "pcx", "qoi", "ico", "psd", "psb", "flc", "fli", "ase", "aseprite",
];
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/** Largest image sent: providers cap an image at about 5 MB of base64. */
export const MAX_SENT_BYTES = 3_750_000;
/** Longest side sent as it is; larger images are scaled down to SHRINK_SIDE. */
export const MAX_SIDE = 2048;
export const SHRINK_SIDE = 1280;
/** Images with a longer side under this are pixel art: scaled up (nearest) to about UPSCALE_TARGET. */
export const SMALL_SIDE = 256;
export const UPSCALE_TARGET = 512;

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** What a file's header says: the format (when a provider takes it), size, and whether it animates. */
export interface ImageInfo {
  format?: "png" | "jpeg" | "gif" | "webp";
  width: number;
  height: number;
  animated: boolean;
}

/** Reads the header of a PNG, JPEG, GIF or WebP; anything else has no format. */
export function sniffImage(b: Buffer): ImageInfo {
  const none: ImageInfo = { width: 0, height: 0, animated: false };
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    // APNG: an acTL chunk before the first IDAT.
    let animated = false;
    for (let o = 8; o + 8 <= b.length;) {
      const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
      if (type === "acTL") animated = true;
      if (type === "IDAT" || type === "IEND") break;
      o += 12 + len;
    }
    return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), animated };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let o = 2; o + 9 < b.length;) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { o += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { format: "jpeg", width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5), animated: false };
      }
      o += 2 + b.readUInt16BE(o + 2);
    }
    return { ...none, format: "jpeg" };
  }
  if (b.length >= 13 && b.toString("latin1", 0, 4) === "GIF8") {
    return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8), animated: gifFrames(b) > 1 };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") {
      return { format: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated: (b[20] & 0x02) !== 0 };
    }
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { format: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), animated: false };
    }
    if (chunk === "VP8 ") return { format: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false };
    return { ...none, format: "webp" };
  }
  return none;
}

/** Counts a GIF's image descriptors by walking its blocks. */
function gifFrames(b: Buffer): number {
  let o = 13;
  if (b[10] & 0x80) o += 3 * (1 << ((b[10] & 7) + 1));
  const skipSub = () => { while (o < b.length && b[o] !== 0) o += b[o] + 1; o++; };
  let frames = 0;
  while (o < b.length) {
    const id = b[o];
    if (id === 0x3b) break;
    if (id === 0x21) { o += 2; skipSub(); continue; }
    if (id !== 0x2c) break;
    frames++;
    if (frames > 1) return frames;
    const flags = b[o + 9];
    o += 10;
    if (flags & 0x80) o += 3 * (1 << ((flags & 7) + 1));
    o++; // LZW minimum code size
    skipSub();
  }
  return frames;
}

/** The frames of an image file as Aseprite reads them (visible layers flattened). */
export interface DecodedFrames {
  frames: Rgba[];
  durations: number[];
}
export type FrameDecoder = (path: string) => Promise<DecodedFrames>;

const execFileP = promisify(execFile);

/** Decodes with `aseprite -b <file> --sheet`: the sheet PNG plus a JSON of frame rectangles and durations. */
export const asepriteFrames: FrameDecoder = async (path) => {
  const { asepriteBin } = await import("./cli.js");
  const dir = mkdtempSync(join(tmpdir(), "ase-attach-"));
  try {
    const sheet = join(dir, "sheet.png"), data = join(dir, "sheet.json");
    await execFileP(asepriteBin(), ["-b", path, "--sheet", sheet, "--sheet-type", "packed", "--data", data, "--format", "json-array"], { timeout: 60_000 });
    const img = decodePng(readFileSync(sheet));
    const meta = JSON.parse(readFileSync(data, "utf8")) as { frames: { frame: { x: number; y: number; w: number; h: number }; duration: number }[] };
    return {
      frames: meta.frames.map(({ frame: r }) => crop(img, r)),
      durations: meta.frames.map((f) => f.duration),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One decoded image (one frame or an animation) as a PNG block with a label that says what it shows. */
export function renderFrames(label: string, d: DecodedFrames): ImageBlock {
  const { frames, durations } = d;
  if (!frames.length) throw new Error(`${label}: the file has no frames`);
  const { width: w, height: h } = frames[0];
  let img: Rgba, note: string;
  if (frames.length === 1) {
    const big = Math.max(w, h);
    if (big > MAX_SIDE) {
      img = shrink(frames[0], SHRINK_SIDE);
      note = `${w}x${h}, shown scaled down to ${img.width}x${img.height}`;
    } else if (big < SMALL_SIDE) {
      const z = Math.max(1, Math.floor(UPSCALE_TARGET / big));
      img = z > 1 ? scale(frames[0], z) : frames[0];
      note = z > 1 ? `${w}x${h} px, shown at ${z}x` : `${w}x${h} px`;
    } else {
      img = frames[0];
      note = `${w}x${h}`;
    }
  } else {
    const layout = filmstripLayout(frames.length, w, h);
    const shown = frames.slice(0, layout.shown).map((f) => flatten(f, "checker", Math.max(1, Math.ceil(4 / layout.zoom))));
    const ms = durations.slice(0, layout.shown);
    const mixed = ms.some((x) => x !== ms[0]);
    img = contactSheet(shown, {
      labels: shown.map((_, i) => String(i + 1)), notes: mixed ? ms.map((x) => `${x}MS`) : undefined,
      columns: layout.columns, zoom: layout.zoom, background: SHEET_BACKDROP, labelColor: SHEET_LABEL,
    });
    const timing = mixed ? `durations ${ms.join(", ")} ms` : `${ms[0]} ms each`;
    const cut = layout.shown < frames.length ? `; only the first ${layout.shown} fit` : "";
    note = `animation, ${plural(frames.length, "frame")} of ${w}x${h} px (${timing}${cut}), ` +
      `shown as a sheet of numbered cells at ${layout.zoom}x, left to right then top to bottom`;
  }
  const data = encodePng(img);
  if (data.length > MAX_SENT_BYTES) throw new Error(`${label}: too large to send even after converting (${Math.round(data.length / 1e6)} MB)`);
  return { label: `${label} (${note})`, mimeType: "image/png", data: data.toString("base64") };
}

/**
 * Reads attached image files into image blocks, converting what providers can't take as it is.
 * Throws with a message the panel can show.
 */
export async function loadAttachments(list: Attachment[] | undefined, decode: FrameDecoder = asepriteFrames): Promise<ImageBlock[]> {
  if (!list?.length) return [];
  if (list.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);
  const out: ImageBlock[] = [];
  for (const { label: rawLabel, path } of list) {
    const label = String(rawLabel);
    const ext = extname(String(path)).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`${label}: attach an image (${IMAGE_EXTENSIONS.join(", ")})`);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`${label}: file not found (${path})`);
    }
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${label}: larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const bytes = readFileSync(path);
    const info = sniffImage(bytes);
    const big = Math.max(info.width, info.height);
    if (info.format && !info.animated && big >= SMALL_SIDE && big <= MAX_SIDE && size <= MAX_SENT_BYTES) {
      out.push({ label: `${label} (${info.width}x${info.height})`, mimeType: MIME[info.format], data: bytes.toString("base64") });
      continue;
    }
    let decoded: DecodedFrames;
    try {
      decoded = await decode(path);
    } catch (e) {
      throw new Error(`${label}: Aseprite could not read it (${(e as Error).message.split("\n")[0]})`);
    }
    out.push(renderFrames(label, decoded));
  }
  return out;
}

/** Deletes rendered attachments older than `days` (default 7). */
export function cleanAttachments(dir = attachmentDir, days = 7, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > days * 86_400_000) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}
