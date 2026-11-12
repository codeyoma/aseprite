// Pose import (#112): key poses from ComfyUI (one image per pose, optionally OpenPose keypoints and a mask per body
// part) turned into clean frames of one animation. Unlike cutting a sheet panel by panel, every pose gets the same
// treatment: one anchor (the hips from the keypoints, else the feet) puts the poses on one body position, one crop
// and one pixel grid (the same scale and phase) shrink them together, and one palette snaps them, so the poses don't
// boil against each other at import. Keypoints become landmarks in sprite pixels; masks cut the pose into part
// layers, so a layered character needs no regenerated part sheets and no alignment guess.
import { quantize, type RGBA } from "./color.js";
import { countColors, snapToPalette, type Rgba } from "./image.js";
import { resample } from "./pixel_grid.js";
import { removeBackground } from "./sheet.js";

const OPAQUE = 128;
type Pt = [number, number];

/** OpenPose body joints by index: COCO 18 (ControlNet's OpenPose and DWPose), and BODY_25 (with a mid hip at 8). */
export const COCO18 = ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "r_hip", "r_knee", "r_ankle",
  "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear"];
export const BODY25 = ["nose", "neck", "r_shoulder", "r_elbow", "r_wrist", "l_shoulder", "l_elbow", "l_wrist", "mid_hip", "r_hip", "r_knee",
  "r_ankle", "l_hip", "l_knee", "l_ankle", "r_eye", "l_eye", "r_ear", "l_ear", "l_big_toe", "l_small_toe", "l_heel", "r_big_toe", "r_small_toe", "r_heel"];

/**
 * The first person's joints of an OpenPose JSON (a file's object, or ComfyUI's list of them), in source pixels
 * (normalized coordinates are scaled by the canvas size), skipping joints with no confidence.
 */
export function parseKeypoints(json: any, size: { width: number; height: number }): Record<string, Pt> {
  const doc = Array.isArray(json) ? json[0] : json;
  const person = doc?.people?.[0];
  const flat: number[] = person?.pose_keypoints_2d ?? [];
  if (!flat.length) throw new Error("No person in the keypoints (expected OpenPose JSON: people[0].pose_keypoints_2d).");
  const names = flat.length / 3 >= 25 ? BODY25 : COCO18;
  const cw = doc.canvas_width ?? size.width, ch = doc.canvas_height ?? size.height;
  const normalized = flat.every((v, i) => i % 3 === 2 || v <= 1.0001);
  const sx = size.width / cw, sy = size.height / ch;
  const out: Record<string, Pt> = {};
  for (let i = 0; i < names.length && i * 3 + 2 < flat.length; i++) {
    const [x, y, c] = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]];
    if (!(c > 0) || (x === 0 && y === 0)) continue;
    out[names[i]] = normalized ? [x * size.width, y * size.height] : [x * sx, y * sy];
  }
  if (!out.mid_hip && out.r_hip && out.l_hip) out.mid_hip = [(out.r_hip[0] + out.l_hip[0]) / 2, (out.r_hip[1] + out.l_hip[1]) / 2];
  return out;
}

export interface PoseIn {
  image: Rgba;
  keypoints?: Record<string, Pt>;
  /** Part name -> mask image (white or opaque where the part is), the pose's size. */
  masks?: Record<string, Rgba>;
}

export type Anchor = "hips" | "feet" | "source";

export interface PoseImport {
  width: number;
  height: number;
  frames: Rgba[];
  /** Part name -> one image per pose. */
  parts: Record<string, Rgba[]>;
  palette: RGBA[];
  /** Per pose: the keypoints in sprite pixels. */
  landmarks: Record<string, Pt>[];
  /** Source pixels per sprite pixel, and the anchor used. */
  scale: number;
  anchor: Anchor;
  notes: string[];
}

const hasAlpha = (img: Rgba) => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true; return false; };

function bbox(img: Rgba): [number, number, number, number] | undefined {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3] < OPAQUE) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? undefined : [x0, y0, x1, y1];
}

function feetOf(img: Rgba, b: [number, number, number, number]): Pt {
  let s = 0, n = 0;
  for (let x = b[0]; x <= b[2]; x++) if (img.data[(b[3] * img.width + x) * 4 + 3] >= OPAQUE) { s += x; n++; }
  return [s / Math.max(1, n) + 0.5, b[3] + 1];
}

/** img copied into a w x h canvas at (dx, dy). */
function place(img: Rgba, w: number, h: number, dx: number, dy: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < img.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= w) continue;
      out.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (ty * w + tx) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

const isOn = (m: Rgba, i: number) => m.data[i * 4 + 3] >= OPAQUE && m.data[i * 4] + m.data[i * 4 + 1] + m.data[i * 4 + 2] >= 3 * 128;

/**
 * Imports poses into width x height frames. scale: source pixels per sprite pixel (default: the largest pose span
 * fits the canvas with a 1 px margin); anchor: hips (needs keypoints on every pose), feet or source (as placed).
 */
export function importPoses(poses: PoseIn[], o: { width: number; height: number; colors?: number; scale?: number; anchor?: Anchor }): PoseImport {
  if (!poses.length) throw new Error("No poses.");
  const notes: string[] = [];
  const clean = poses.map((p, i) => {
    if (hasAlpha(p.image)) return p.image;
    notes.push(`pose ${i + 1}: no transparency, so its background was keyed out`);
    return removeBackground(p.image);
  });
  const boxes = clean.map((img, i) => {
    const b = bbox(img);
    if (!b) throw new Error(`Pose ${i + 1} is empty.`);
    return b;
  });
  const anchor: Anchor = o.anchor ?? (poses.every((p) => p.keypoints?.mid_hip) ? "hips" : "feet");
  if (anchor === "hips" && !poses.every((p) => p.keypoints?.mid_hip)) throw new Error("anchor 'hips' needs hip keypoints on every pose.");
  const anchors: Pt[] = clean.map((img, i) => anchor === "hips" ? poses[i].keypoints!.mid_hip : anchor === "feet" ? feetOf(img, boxes[i]) : [0, 0]);
  // Shifts that put every pose's anchor on the first one's (whole source pixels).
  const shifts: Pt[] = anchors.map((a) => [Math.round(anchors[0][0] - a[0]), Math.round(anchors[0][1] - a[1])]);
  if (anchor === "feet") shifts.forEach((s, i) => { s[1] = boxes[0][3] - boxes[i][3]; });
  const ux0 = Math.min(...boxes.map((b, i) => b[0] + shifts[i][0])), uy0 = Math.min(...boxes.map((b, i) => b[1] + shifts[i][1]));
  const ux1 = Math.max(...boxes.map((b, i) => b[2] + shifts[i][0])), uy1 = Math.max(...boxes.map((b, i) => b[3] + shifts[i][1]));
  const uw = ux1 - ux0 + 1, uh = uy1 - uy0 + 1;
  const scale = o.scale ?? Math.max(1, Math.max(uw / Math.max(1, o.width - 2), uh / Math.max(1, o.height - 2)));
  const grid = { cellX: scale, cellY: scale, offsetX: 0, offsetY: 0, confidence: 1 };
  const aligned = (img: Rgba, i: number) => place(img, uw, uh, shifts[i][0] - ux0, shifts[i][1] - uy0);
  const small = clean.map((img, i) => resample(aligned(img, i), grid));
  const sw = small[0].width, sh = small[0].height;
  if (sw > o.width || sh > o.height) throw new Error(`At scale ${scale.toFixed(2)} the poses are ${sw}x${sh} sprite pixels, larger than ${o.width}x${o.height}; give a larger scale.`);
  // One placement for all: centered across, on the bottom row.
  const ox = Math.floor((o.width - sw) / 2), oy = o.height - sh;
  const palette = quantize(small.flatMap((img) => countColors(img)), o.colors ?? 16).map((c) => ({ r: c.r, g: c.g, b: c.b, a: 255 }));
  const frames = small.map((img) => snapToPalette(place(img, o.width, o.height, ox, oy), palette));
  const toSprite = (p: Pt, i: number): Pt => [
    Math.round(((p[0] + shifts[i][0] - ux0) / scale + ox) * 10) / 10,
    Math.round(((p[1] + shifts[i][1] - uy0) / scale + oy) * 10) / 10,
  ];
  const landmarks = poses.map((p, i) => Object.fromEntries(Object.entries(p.keypoints ?? {}).map(([k, v]) => [k, toSprite(v, i)])));
  // Masks: the same move and grid, then each part takes the frame's pixels under its mask (first mask wins).
  const parts: Record<string, Rgba[]> = {};
  const names = [...new Set(poses.flatMap((p) => Object.keys(p.masks ?? {})))];
  if (names.length) {
    frames.forEach((frame, i) => {
      const taken = new Uint8Array(o.width * o.height);
      for (const name of names) {
        const out = new Uint8Array(o.width * o.height * 4);
        const m = poses[i].masks?.[name];
        if (m) {
          const opaque = { width: m.width, height: m.height, data: new Uint8Array(m.data) };
          for (let k = 0; k < m.width * m.height; k++) opaque.data[k * 4 + 3] = isOn(m, k) ? 255 : 0;
          const sm = place(resample(aligned(opaque, i), grid), o.width, o.height, ox, oy);
          for (let k = 0; k < o.width * o.height; k++) {
            if (taken[k] || sm.data[k * 4 + 3] < OPAQUE || frame.data[k * 4 + 3] < OPAQUE) continue;
            taken[k] = 1;
            out.set(frame.data.subarray(k * 4, k * 4 + 4), k * 4);
          }
        }
        (parts[name] ??= []).push({ width: o.width, height: o.height, data: out });
      }
      let left = 0;
      for (let k = 0; k < o.width * o.height; k++) if (!taken[k] && frame.data[k * 4 + 3] >= OPAQUE) left++;
      if (left) notes.push(`pose ${i + 1}: ${left} px under no mask stay on the pose layer`);
    });
  }
  return { width: o.width, height: o.height, frames, parts, palette, landmarks, scale: Math.round(scale * 100) / 100, anchor, notes };
}
