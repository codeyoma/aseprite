// Attachments (#21): images the user attaches in the chat panel. The
// extension renders a selection, layer or frame to a PNG under
// ~/.aseprite-agent/attachments (or the user picks an image file), and sends
// the paths with the message; the bridge reads them into ACP image blocks.
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { sessionDir } from "./session.js";

export const attachmentDir = join(sessionDir, "attachments");

/** An attachment as the panel sends it. */
export interface Attachment {
  label: string;
  path: string;
}

/** An image ready for the agent. */
export interface ImageBlock {
  label: string;
  mimeType: string;
  data: string; // base64
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

/** Reads attached image files. Throws with a message the panel can show. */
export function loadAttachments(list: Attachment[] | undefined): ImageBlock[] {
  if (!list?.length) return [];
  if (list.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);
  return list.map(({ label, path }) => {
    const mimeType = MIME[extname(String(path)).toLowerCase()];
    if (!mimeType) throw new Error(`${label}: only PNG, JPEG, GIF and WebP images can be attached`);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`${label}: file not found (${path})`);
    }
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${label}: larger than 10 MB`);
    return { label: String(label), mimeType, data: readFileSync(path).toString("base64") };
  });
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
