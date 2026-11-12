// Walk limb check (#99): whether a side-view walk's near arm swings opposite its near leg. Measured on the two
// contact frames from limbs the agent names (part layers, or colors within rows), never guessed from the whole
// figure: the hand's offset from the shoulder and the foot's offset from the hip, toward the facing direction.
import type { Rgba } from "./image.js";
import { silhouette } from "./motion_analysis.js";
import { parseHex, toOklab } from "./color.js";
import type { Document } from "./document.js";

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
  /** Mean OKLab lightness of the near leg and of the other leg pixels in its rows (the far leg), when both are there. */
  legLight?: { near: number; far: number; farPixels: number };
}

/** How much lighter (OKLab L) the near leg must be than the far leg for a player to tell them apart at a glance. */
export const MIN_DEPTH = 0.12;

/**
 * The near leg's and the far leg's mean lightness at a contact: the near leg's own pixels (its mask, `near`), against
 * every other opaque pixel of the composite below the hip (`whole`, rows under the near leg's top row).
 */
export function legLightness(whole: Rgba, near: boolean[]): ContactReading["legLight"] {
  const w = whole.width;
  const top = near.findIndex((v) => v);
  if (top < 0) return undefined;
  const y0 = Math.floor(top / w) + 1;
  let ln = 0, nn = 0, lf = 0, nf = 0;
  for (let y = y0; y < whole.height; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = i * 4;
    if (whole.data[d + 3] < 128) continue;
    const L = toOklab({ r: whole.data[d], g: whole.data[d + 1], b: whole.data[d + 2], a: 255 }).L;
    if (near[i]) { ln += L; nn++; } else { lf += L; nf++; }
  }
  if (!nn || nf < 3) return undefined;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { near: r(ln / nn), far: r(lf / nf), farPixels: nf };
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
    if (c.legLight && c.legLight.near - c.legLight.far < MIN_DEPTH) {
      errors.push(`frame ${c.frame}: the near leg (lightness ${c.legLight.near}) isn't clearly lighter than the far leg ` +
        `(${c.legLight.far}), so a player can't tell which leg is near and pairs the arm with the wrong one; make the near ` +
        `leg at least ${MIN_DEPTH} lighter (OKLab L), or the far leg darker`);
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

/** One frame of the cycle: the figure's top row (head) and the near limbs' sizes in px. */
export interface CycleReading {
  frame: number;
  top?: number;
  arm: number;
  leg: number;
}

/** A near limb may grow or shrink by at most this factor across the cycle (foreshortening, bends) before it reads as redrawn. */
export const MAX_LIMB_RATIO = 1.6;

/**
 * Weight and consistency over the whole cycle: the body must bob (the head's top row moves by at least 1 px, highest
 * away from the contacts, where the weight lands), and each near limb keeps about the same size in every frame.
 */
export function judgeCycle(cycle: CycleReading[], contacts: number[]): { errors: string[] } {
  const errors: string[] = [];
  const tops = cycle.filter((c) => c.top !== undefined) as (CycleReading & { top: number })[];
  if (tops.length >= 4) {
    const hi = Math.min(...tops.map((c) => c.top)), lo = Math.max(...tops.map((c) => c.top));
    if (hi === lo) {
      errors.push(`no bob: the head's top stays on row ${hi} in every frame, so the walk has no weight; lower the body ` +
        `1 px on the contacts and the frame after them, and raise it 1 px on the passing poses`);
    } else {
      const highest = tops.filter((c) => c.top === hi).map((c) => c.frame);
      if (highest.every((f) => contacts.includes(f))) {
        errors.push(`the body is highest on the contact frame${highest.length > 1 ? "s" : ""} ${highest.join(", ")}; ` +
          `the weight lands there, so contacts sit low and the passing poses high`);
      }
    }
  }
  for (const [name, key] of [["near arm", "arm"], ["near leg", "leg"]] as const) {
    const sizes = cycle.map((c) => c[key]).filter((n) => n > 0);
    if (sizes.length < 2) continue;
    const min = Math.min(...sizes), max = Math.max(...sizes);
    if (max / min > MAX_LIMB_RATIO) {
      const at = (n: number) => cycle.find((c) => c[key] === n)!.frame;
      errors.push(`the ${name} changes size across the cycle (${min} px in frame ${at(min)}, ${max} px in frame ${at(max)}); ` +
        `keep its length and thickness and move or rotate it instead of redrawing it`);
    }
  }
  return { errors };
}

export interface WalkInput {
  tag?: string;
  facing?: "right" | "left";
  contacts?: [number, number];
  nearArm?: LimbSelector;
  nearLeg?: LimbSelector;
}

export interface WalkMeasure {
  contract: WalkContract;
  readings: ContactReading[];
  /** Every frame of the tag: head row and near limb sizes (judgeCycle). */
  cycle: CycleReading[];
  verdict: WalkVerdict;
  /** The contract differs from the stored one (the caller stores it on the clip, MotionStore.setWalkContract). */
  changed: boolean;
}

const hasSel = (l?: LimbSelector) => !!l && (!!l.layer || !!l.colors?.length);

/**
 * The walk's contract (the input, else the one stored on the tag's Motion Clip, else layers named like "near arm" and
 * "near leg") and its measurement on the contacts, plus, unless `contactsOnly` (the keys stage, #109), the whole
 * cycle. Throws with a message for the agent when something is missing.
 */
export async function measureWalk(doc: Document, input: WalkInput, stored: Partial<WalkContract> = {}, o: { contactsOnly?: boolean } = {}): Promise<WalkMeasure> {
  const info = await doc.info();
  const tagName = input.tag ?? stored.tag ?? "walk";
  const tag = info.tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
  if (!tag) throw new Error(`No tag "${tagName}": tag the walk's frames first, or pass tag.`);
  const n = tag.to - tag.from + 1;
  const named = (re: RegExp) => info.layers.find((l) => re.test(l.name))?.name;
  const contract: WalkContract = {
    tag: tag.name,
    facing: input.facing ?? stored.facing ?? "right",
    contacts: input.contacts ?? stored.contacts ?? [tag.from, tag.from + Math.floor(n / 2)],
    nearArm: input.nearArm ?? stored.nearArm ?? { layer: named(/near[ _-]?arm/i) },
    nearLeg: input.nearLeg ?? stored.nearLeg ?? { layer: named(/near[ _-]?leg/i) },
  };
  if (!hasSel(contract.nearArm) || !hasSel(contract.nearLeg)) {
    throw new Error("Name the near arm and near leg: near_arm and near_leg as part layers, or as colors with rows " +
      "(the arm's rows above the hip, the leg's below), or name the part layers 'near arm' and 'near leg'.");
  }
  for (const f of contract.contacts) if (f < 1 || f > info.durations.length) throw new Error(`Frame ${f} doesn't exist.`);
  const readings: ContactReading[] = [];
  for (const frame of contract.contacts) {
    const read = async (l: LimbSelector) => {
      const img = await doc.pixels(l.layer, frame);
      return readLimb(limbMask(img, l), img.width, contract.facing);
    };
    const legImg = await doc.pixels(contract.nearLeg.layer, frame);
    const legMask = limbMask(legImg, contract.nearLeg);
    const whole = contract.nearLeg.layer ? await doc.pixels(undefined, frame) : legImg;
    readings.push({
      frame, arm: await read(contract.nearArm), leg: readLimb(legMask, legImg.width, contract.facing),
      legLight: legLightness(whole, fromTop(legMask, legImg.width)),
    });
  }
  const cycle: CycleReading[] = [];
  // The whole cycle, each source in one request (#114).
  const cycleFrames = o.contactsOnly ? [] : Array.from({ length: tag.to - tag.from + 1 }, (_, i) => tag.from + i);
  if (cycleFrames.length) {
    const wholes = await doc.pixelsMany(undefined, cycleFrames);
    const of = async (l: LimbSelector) => (l.layer ? await doc.pixelsMany(l.layer, cycleFrames) : wholes);
    const arms = await of(contract.nearArm), legs = await of(contract.nearLeg);
    const size = (img: Rgba, l: LimbSelector) => fromTop(limbMask(img, l), img.width).filter(Boolean).length;
    cycleFrames.forEach((frame, i) => cycle.push({
      frame, top: silhouette(wholes[i], frame).bounds?.[1], arm: size(arms[i], contract.nearArm), leg: size(legs[i], contract.nearLeg),
    }));
  }
  const verdict = judgeWalk(readings);
  const more = o.contactsOnly ? [] : judgeCycle(cycle, contract.contacts).errors;
  if (more.length) { verdict.errors.push(...more); verdict.status = "errors"; }
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  const changed = stored.tag?.toLowerCase() !== contract.tag.toLowerCase() || stored.facing !== contract.facing ||
    !same(stored.contacts, contract.contacts) || !same(stored.nearArm, contract.nearArm) || !same(stored.nearLeg, contract.nearLeg);
  return { contract, readings, cycle, verdict, changed };
}
