// Walk limb check (#99): whether a side-view walk's near arm swings opposite its near leg. Measured on the two
// contact frames from limbs the agent names (part layers, or colors within rows), never guessed from the whole
// figure: the hand's offset from the shoulder and the foot's offset from the hip, toward the facing direction.
import type { Rgba } from "./image.js";
import { parseHex } from "./color.js";

/** A limb: a part layer, and/or colors (hex) within rows [y0, y1] of the canvas. */
export interface LimbSelector {
  layer?: string;
  colors?: string[];
  rows?: [number, number];
}

export interface WalkContract {
  tag: string;
  facing: "right" | "left";
  /** The two contact frames (sprite frame numbers). */
  contacts: [number, number];
  nearArm: LimbSelector;
  nearLeg: LimbSelector;
}

/** The pixels of a limb in an image (alpha >= 128, the selector's colors and rows). */
export function limbMask(img: Rgba, sel: LimbSelector): boolean[] {
  const colors = sel.colors?.map((h) => parseHex(h)).filter((c) => c !== undefined) ?? [];
  const [y0, y1] = sel.rows ?? [0, img.height - 1];
  const mask = new Array<boolean>(img.width * img.height).fill(false);
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 128) continue;
      if (colors.length && !colors.some((c) => c!.r === img.data[i] && c!.g === img.data[i + 1] && c!.b === img.data[i + 2])) continue;
      mask[y * img.width + x] = true;
    }
  }
  return mask;
}

export interface LimbReading {
  pixels: number;
  /** Mean x of the top rows (shoulder or hip) and of the bottom rows (hand or foot). */
  root?: [number, number];
  tip?: [number, number];
  /** tip minus root along the facing direction, in px: + forward, - back; undefined when there is no limb. */
  offset?: number;
}

/**
 * The part of a mask connected (8 ways) to its top row: the limb from its shoulder or hip down, without stray pixels of
 * the same color elsewhere (the far arm's hand peeking past the body).
 */
export function fromTop(mask: boolean[], width: number): boolean[] {
  const height = mask.length / width;
  const out = new Array<boolean>(mask.length).fill(false);
  const top = mask.findIndex((v) => v);
  if (top < 0) return out;
  const y0 = Math.floor(top / width);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) if (mask[y0 * width + x]) { out[y0 * width + x] = true; stack.push(y0 * width + x); }
  while (stack.length) {
    const i = stack.pop()!, x = i % width, y = Math.floor(i / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, j = ny * width + nx;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && mask[j] && !out[j]) { out[j] = true; stack.push(j); }
    }
  }
  return out;
}

/**
 * Where a limb's tip is relative to its root: the mean x of its top two rows and of its bottom two rows, over the part
 * connected to the top row.
 */
export function readLimb(whole: boolean[], width: number, facing: "right" | "left"): LimbReading {
  const mask = fromTop(whole, width);
  const height = mask.length / width;
  const rows: { y: number; xs: number[] }[] = [];
  for (let y = 0; y < height; y++) {
    const xs: number[] = [];
    for (let x = 0; x < width; x++) if (mask[y * width + x]) xs.push(x);
    if (xs.length) rows.push({ y, xs });
  }
  const pixels = rows.reduce((n, r) => n + r.xs.length, 0);
  if (rows.length < 2) return { pixels };
  const mean = (rs: typeof rows) => {
    const xs = rs.flatMap((r) => r.xs);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const top = rows.slice(0, 2), bottom = rows.slice(-2);
  const rx = mean(top), tx = mean(bottom);
  const offset = Math.round((tx - rx) * (facing === "right" ? 1 : -1) * 10) / 10;
  return { pixels, root: [Math.round(rx * 10) / 10, top[0].y], tip: [Math.round(tx * 10) / 10, bottom[bottom.length - 1].y], offset };
}

/** Below this many px a limb hangs straight: neither forward nor back, so it can't be judged. */
export const MIN_SWING = 1;

export interface ContactReading {
  frame: number;
  arm: LimbReading;
  leg: LimbReading;
}

export interface WalkVerdict {
  status: "ok" | "errors" | "unverifiable";
  errors: string[];
  unverifiable: string[];
}

const side = (o: number) => (o > 0 ? "forward" : "back");

/**
 * The verdict on two contacts: at each one the near arm and near leg point opposite ways, and each limb points the
 * other way at the second contact. A limb that is missing or hangs straight makes that part unverifiable, never ok.
 */
export function judgeWalk(contacts: ContactReading[]): WalkVerdict {
  const errors: string[] = [], unverifiable: string[] = [];
  const swing = (r: LimbReading) => r.offset !== undefined && Math.abs(r.offset) >= MIN_SWING;
  for (const c of contacts) {
    for (const [name, r] of [["near arm", c.arm], ["near leg", c.leg]] as const) {
      if (!r.pixels) unverifiable.push(`frame ${c.frame}: no ${name} pixels (check the layer or colors and rows)`);
      else if (!swing(r)) unverifiable.push(`frame ${c.frame}: the ${name} hangs straight (offset ${r.offset ?? 0} px)`);
    }
    if (swing(c.arm) && swing(c.leg) && Math.sign(c.arm.offset!) === Math.sign(c.leg.offset!)) {
      errors.push(`frame ${c.frame} (contact): the near arm and the near leg both swing ${side(c.arm.offset!)} ` +
        `(arm ${c.arm.offset} px, leg ${c.leg.offset} px); the arm must swing opposite the leg on its side`);
    }
  }
  if (contacts.length === 2) {
    const [a, b] = contacts;
    for (const [name, ra, rb] of [["near arm", a.arm, b.arm], ["near leg", a.leg, b.leg]] as const) {
      if (swing(ra) && swing(rb) && Math.sign(ra.offset!) === Math.sign(rb.offset!)) {
        errors.push(`the ${name} swings ${side(ra.offset!)} at both contacts (frames ${a.frame} and ${b.frame}: ${ra.offset} and ` +
          `${rb.offset} px); it must change sides between them`);
      }
    }
  }
  return { status: errors.length ? "errors" : unverifiable.length ? "unverifiable" : "ok", errors, unverifiable };
}
