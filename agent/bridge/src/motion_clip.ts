// Motion Clip (#109): the intended motion as data, one module that owns it. A sprite's motion store (the sprite
// property aseprite-agent "motion", versioned JSON) holds a rig per character (part layers, parents, joints in
// sprite pixels at a base frame) and a clip per tag (kind, facing, loop, timed keys, contacts, followers, the walk's
// near limbs and the stage). Import fills it, the stage gate (extension/motion_gate.lua) enforces its keys stage,
// walk_check reads its walk contract, and the inbetweener (#110) and motion analysis (#111) read it.
//
// Frames in a clip are tag-relative (1 = the tag's first frame), so inserting frames before the tag keeps them right;
// the module turns them into sprite frame numbers for callers. Timing is never stored: it comes from the frame
// durations.
import * as z from "zod/v4";
import type { Document, SpriteInfo, TagInfo } from "./document.js";
import type { LimbSelector, WalkContract } from "./walk_check.js";

export const MOTION_VERSION = 1;
/** The most text the store may have (protocol.json put_images motion). */
export const MOTION_MAX = 65536;

const point = z.tuple([z.number(), z.number()]);
const limb = z.object({ layer: z.string().optional(), colors: z.array(z.string()).optional(), rows: z.tuple([z.number().int(), z.number().int()]).optional() });

export const partSchema = z.object({
  /** The part's layer name (layer ids change between sessions). */
  layer: z.string().min(1),
  /** The parent part's layer; none for the root (the torso or hips). */
  parent: z.string().optional(),
  /** Where the part attaches to its parent, in sprite pixels at the rig's base frame (a shoulder, a hip). */
  joint: point.optional(),
  /** Its far end at the base frame (a hand, a foot, a blade's tip): with joint, its rest direction and length. */
  end: point.optional(),
  /** True for a part that keeps its length (a forearm, a sword); hair and cloth bend. Default true. */
  rigid: z.boolean().optional(),
  /** Where joint and end came from: "derived" (suggested from pixels, check it), "set" or an import's name. */
  source: z.string().optional(),
});
export type RigPart = z.infer<typeof partSchema>;

export const rigSchema = z.object({
  /** The sprite frame the joints are measured on (the base pose). */
  base: z.number().int().min(1),
  parts: z.array(partSchema),
  /** Provenance of an imported skeleton (#112): its format (e.g. "openpose-18") and source file. */
  source: z.object({ format: z.string().optional(), path: z.string().optional() }).optional(),
});
export type Rig = z.infer<typeof rigSchema>;

export const keySchema = z.object({
  /** Tag-relative frame (1 = the tag's first frame). */
  at: z.number().int().min(1),
  /** What the pose is (contact, passing, anticipation, hit...). */
  pose: z.string().optional(),
  /** A hold: this key may repeat the key before it. */
  hold: z.boolean().optional(),
});
export type ClipKey = z.infer<typeof keySchema>;

export const STAGES = ["none", "keys", "inbetweens", "done"] as const;
export type Stage = (typeof STAGES)[number];
export const KINDS = ["walk", "run", "idle", "cycle", "action"] as const;
export type ClipKind = (typeof KINDS)[number];

export const clipSchema = z.object({
  character: z.string().optional(),
  kind: z.enum(KINDS),
  facing: z.enum(["right", "left"]).default("right"),
  loop: z.boolean(),
  keys: z.array(keySchema),
  /** Tag-relative frames where a foot is planted and carries the weight (a walk's contacts). */
  contacts: z.array(z.number().int().min(1)).optional(),
  /** Pixels the body travels over one loop (a walk in place: how far the planted foot slides back). */
  rootTravel: z.number().optional(),
  /** Parts that follow another part late (hair, a cape): lag in frames. */
  followers: z.array(z.object({ layer: z.string(), follows: z.string(), lag: z.number().min(0).max(4) })).optional(),
  /** The walk's near limbs, for walk_check (#99). */
  walk: z.object({ nearArm: limb, nearLeg: limb }).optional(),
  stage: z.enum(STAGES),
});
export type Clip = z.infer<typeof clipSchema>;

export const motionSchema = z.object({
  version: z.literal(MOTION_VERSION),
  rigs: z.record(z.string(), rigSchema),
  clips: z.record(z.string(), clipSchema),
});
export type Motion = z.infer<typeof motionSchema>;

const empty = (): Motion => ({ version: MOTION_VERSION, rigs: {}, clips: {} });

/** Parses the store's text; throws a message for the agent when it is malformed or from a newer version. */
export function parseMotion(text: string): Motion {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`The sprite's motion store is not valid JSON: ${(e as Error).message}`);
  }
  if (v && typeof v === "object" && typeof v.version === "number" && v.version > MOTION_VERSION) {
    throw new Error(`The sprite's motion store is version ${v.version}; this bridge reads version ${MOTION_VERSION}. Update the agent.`);
  }
  const r = motionSchema.safeParse(v);
  if (!r.success) throw new Error(`The sprite's motion store is malformed: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** The kind a tag's name suggests. */
export function kindOf(tagName: string): ClipKind {
  if (/run|sprint|dash/i.test(tagName)) return "run";
  if (/walk/i.test(tagName)) return "walk";
  if (/idle|breath|stand/i.test(tagName)) return "idle";
  return "action";
}

const isCycle = (k: ClipKind) => k !== "action";

/**
 * Default keys (tag-relative) for a clip of n frames: a walk or run's contacts and passings (6 frames: 1, 3, 4, 6,
 * `rule:anim.walk.limbs`; 8 frames: 1, 3, 5, 7), otherwise the first and middle frames.
 */
export function defaultKeys(kind: ClipKind, n: number): number[] {
  if ((kind === "walk" || kind === "run") && n >= 4 && n % 2 === 0) {
    if (n === 6) return [1, 3, 4, 6];
    const half = n / 2;
    return [1, 1 + Math.floor(half / 2), 1 + half, 1 + half + Math.floor(half / 2)];
  }
  return n <= 1 ? [1] : [1, 1 + Math.floor(n / 2)];
}

/** A walk or run's default contacts (tag-relative): the first frame and the one halfway. */
export function defaultContacts(kind: ClipKind, n: number): number[] | undefined {
  return (kind === "walk" || kind === "run") && n >= 2 ? [1, 1 + Math.floor(n / 2)] : undefined;
}

/**
 * Builds the clip of the store for older sprites: the pixel spec's `motion` (#99 motion_stage) and `walk` (walk_check)
 * keys, which used sprite frame numbers.
 */
function migrate(info: SpriteInfo): Motion {
  const m = empty();
  let spec: any;
  try { spec = info.pixelSpec ? JSON.parse(info.pixelSpec) : undefined; } catch { spec = undefined; }
  if (!spec || typeof spec !== "object") return m;
  const tagOf = (name?: string) => (name ? info.tags.find((t) => t.name.toLowerCase() === String(name).toLowerCase()) : undefined);
  const legacy = spec.motion, walk = spec.walk;
  const tag = tagOf(legacy?.tag) ?? tagOf(walk?.tag);
  if (!tag) return m;
  const rel = (f: number) => f - tag.from + 1;
  const n = tag.to - tag.from + 1;
  const kind = legacy?.walk || walk ? (kindOf(tag.name) === "run" ? "run" : "walk") : kindOf(tag.name);
  const keys = Array.isArray(legacy?.keys) && tagOf(legacy.tag) === tag ? legacy.keys.map(Number).map(rel) : defaultKeys(kind, n);
  m.clips[tag.name] = {
    kind, facing: walk?.facing === "left" ? "left" : "right", loop: isCycle(kind),
    keys: keys.filter((k: number) => k >= 1 && k <= n).map((at: number) => ({ at })),
    ...(walk?.contacts ? { contacts: walk.contacts.map(Number).map(rel) } : {}),
    ...(walk?.nearArm || walk?.nearLeg ? { walk: { nearArm: walk.nearArm ?? {}, nearLeg: walk.nearLeg ?? {} } } : {}),
    stage: STAGES.includes(legacy?.stage) && tagOf(legacy.tag) === tag ? legacy.stage : "none",
  };
  return m;
}

/** A clip with its tag: frames as sprite frame numbers. */
export interface ClipView {
  name: string;
  tag: TagInfo;
  clip: Clip;
  /** Sprite frame numbers of the keys, contacts and every frame of the tag. */
  keys: number[];
  contacts?: number[];
  frames: number[];
  /** ms from the tag's start to each of its frames, and the tag's length in ms. */
  startMs: number[];
  lengthMs: number;
}

/**
 * The motion store of one sprite: read once, changed through its methods, written with save() (one put_images in
 * the sprite's undo history).
 */
export class MotionStore {
  private constructor(private doc: Document, public info: SpriteInfo, public motion: Motion, private dirty: boolean) {}

  /** Reads the sprite's store (migrating the pixel spec's older motion and walk keys when there is none). */
  static async load(doc: Document): Promise<MotionStore> {
    const info = await doc.info();
    if (info.motion) return new MotionStore(doc, info, parseMotion(info.motion), false);
    const m = migrate(info);
    return new MotionStore(doc, info, m, Object.keys(m.clips).length > 0);
  }

  tag(name: string): TagInfo | undefined {
    return this.info.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /** The clip of a tag (by the tag's name, any case), with its frames. */
  view(tagName: string): ClipView | undefined {
    const tag = this.tag(tagName);
    if (!tag) return undefined;
    const key = Object.keys(this.motion.clips).find((k) => k.toLowerCase() === tag.name.toLowerCase());
    if (!key) return undefined;
    return viewOf(tag, this.motion.clips[key], this.info.durations);
  }

  /** Every clip whose tag exists, and the clips whose tag is gone (renamed or deleted). */
  views(): { views: ClipView[]; orphans: string[] } {
    const views: ClipView[] = [], orphans: string[] = [];
    for (const name of Object.keys(this.motion.clips)) {
      const v = this.view(name);
      if (v) views.push(v); else orphans.push(name);
    }
    return { views, orphans };
  }

  /** The clip in the keys or in-betweens stage, if exactly one is; else undefined. */
  active(): ClipView | undefined {
    const staged = this.views().views.filter((v) => v.clip.stage === "keys" || v.clip.stage === "inbetweens");
    return staged.length === 1 ? staged[0] : undefined;
  }

  setClip(tag: TagInfo, clip: Clip): ClipView {
    for (const k of Object.keys(this.motion.clips)) if (k.toLowerCase() === tag.name.toLowerCase()) delete this.motion.clips[k];
    this.motion.clips[tag.name] = clipSchema.parse(clip);
    this.dirty = true;
    return this.view(tag.name)!;
  }

  removeClip(name: string): boolean {
    const k = Object.keys(this.motion.clips).find((c) => c.toLowerCase() === name.toLowerCase());
    if (!k) return false;
    delete this.motion.clips[k];
    this.dirty = true;
    return true;
  }

  rig(character: string): Rig | undefined {
    return this.motion.rigs[character];
  }

  setRig(character: string, rig: Rig): void {
    this.motion.rigs[character] = rigSchema.parse(rig);
    this.dirty = true;
  }

  /**
   * The walk contract stored for a tag (sprite frames), for walk_check: facing, contacts and near limbs. With no tag,
   * the first clip that has near limbs.
   */
  walkContract(tagName?: string): Partial<WalkContract> {
    const v = tagName ? this.view(tagName) : this.views().views.find((x) => x.clip.walk);
    if (!v) return tagName ? {} : {};
    return {
      tag: v.tag.name, facing: v.clip.facing,
      ...(v.contacts && v.contacts.length >= 2 ? { contacts: [v.contacts[0], v.contacts[1]] as [number, number] } : {}),
      ...(v.clip.walk?.nearArm ? { nearArm: v.clip.walk.nearArm as LimbSelector } : {}),
      ...(v.clip.walk?.nearLeg ? { nearLeg: v.clip.walk.nearLeg as LimbSelector } : {}),
    };
  }

  /**
   * Stores a walk contract (from walk_check) on its tag's clip, creating a clip without a stage when the tag has none.
   * Returns whether anything changed.
   */
  setWalkContract(c: WalkContract): boolean {
    const tag = this.tag(c.tag);
    if (!tag) return false;
    const v = this.view(tag.name);
    const n = tag.to - tag.from + 1;
    const kind = v?.clip.kind ?? (kindOf(tag.name) === "run" ? "run" : "walk");
    const base: Clip = v?.clip ?? { kind, facing: "right", loop: true, keys: defaultKeys(kind, n).map((at) => ({ at })), stage: "none" };
    const next: Clip = {
      ...base, facing: c.facing, contacts: c.contacts.map((f) => f - tag.from + 1),
      walk: { nearArm: c.nearArm, nearLeg: c.nearLeg },
    };
    if (JSON.stringify(next) === JSON.stringify(base)) return false;
    this.setClip(tag, next);
    return true;
  }

  /** Writes the store when it changed (or migrated); returns whether it wrote. */
  async save(label: string): Promise<boolean> {
    if (!this.dirty) return false;
    const json = JSON.stringify(this.motion);
    if (json.length > MOTION_MAX) throw new Error(`The motion store is ${json.length} characters; at most ${MOTION_MAX} fit on a sprite.`);
    await this.doc.putImages([], { motion: json, label });
    this.dirty = false;
    return true;
  }
}

export function viewOf(tag: TagInfo, clip: Clip, durations: number[]): ClipView {
  const abs = (f: number) => tag.from + f - 1;
  const frames = Array.from({ length: tag.to - tag.from + 1 }, (_, i) => tag.from + i);
  const startMs: number[] = [];
  let t = 0;
  for (const f of frames) { startMs.push(t); t += durations[f - 1] ?? 100; }
  return {
    name: tag.name, tag, clip, frames, startMs, lengthMs: t,
    keys: clip.keys.map((k) => abs(k.at)).filter((f) => f <= tag.to),
    ...(clip.contacts ? { contacts: clip.contacts.map(abs).filter((f) => f <= tag.to) } : {}),
  };
}

/** One line per fact of a clip, for the agent. */
export function describeClip(v: ClipView): string {
  const c = v.clip;
  const keyText = c.keys.map((k) => `${v.tag.from + k.at - 1}${k.pose ? ` (${k.pose})` : ""}${k.hold ? " hold" : ""}`).join(", ");
  return [
    `Clip "${v.name}" (frames ${v.tag.from}-${v.tag.to}, ${v.lengthMs} ms${c.loop ? ", loops" : ""}): ${c.kind}, facing ${c.facing}${c.character ? `, character "${c.character}"` : ""}; stage "${c.stage}".`,
    `  keys ${keyText || "none"}` + (v.contacts?.length ? `; contacts ${v.contacts.join(", ")}` : "") +
      (c.rootTravel !== undefined ? `; root travel ${c.rootTravel} px per loop` : ""),
    ...(c.followers?.length ? [`  followers: ${c.followers.map((f) => `${f.layer} follows ${f.follows} ${f.lag} frame${f.lag === 1 ? "" : "s"} late`).join("; ")}`] : []),
    ...(c.walk ? [`  near arm: ${selText(c.walk.nearArm)}; near leg: ${selText(c.walk.nearLeg)}`] : []),
  ].join("\n");
}

export const selText = (l: LimbSelector) =>
  [l.layer && `layer "${l.layer}"`, l.colors?.length && `colors ${l.colors.join(" ")}`, l.rows && `rows ${l.rows[0]}-${l.rows[1]}`].filter(Boolean).join(", ") || "unset";

export function describeRig(name: string, r: Rig): string {
  const p = (x?: [number, number]) => (x ? `${x[0]},${x[1]}` : "?");
  return [`Rig "${name}" (base frame ${r.base}${r.source?.format ? `, from ${r.source.format}` : ""}):`,
    ...r.parts.map((q) => `  ${q.layer}${q.parent ? ` <- ${q.parent}` : " (root)"}: joint ${p(q.joint)}, end ${p(q.end)}` +
      `${q.joint && q.end ? `, length ${Math.round(Math.hypot(q.end[0] - q.joint[0], q.end[1] - q.joint[1]) * 10) / 10}` : ""}` +
      `${q.rigid === false ? ", bends" : ""}${q.source ? ` [${q.source}]` : ""}`)].join("\n");
}

/** The parent a part's name suggests, among the other parts (arms and the head hang off the torso, a hand off its arm). */
export function guessParent(layer: string, others: string[]): string | undefined {
  const find = (re: RegExp) => others.find((o) => o !== layer && re.test(o));
  const torso = find(/torso|body|chest|hips?|pelvis/i);
  const side = /near/i.test(layer) ? "near" : /far/i.test(layer) ? "far" : "";
  const sameSide = (re: RegExp) => others.find((o) => o !== layer && re.test(o) && (!side || o.toLowerCase().includes(side)));
  if (/torso|body|chest|pelvis|hips?\b/i.test(layer)) return undefined;
  if (/hand|fist/i.test(layer)) return sameSide(/fore ?arm|arm/i) ?? torso;
  if (/fore ?arm/i.test(layer)) return sameSide(/upper ?arm|^((?!fore).)*arm/i) ?? torso;
  if (/foot|shoe|boot/i.test(layer)) return sameSide(/shin|calf|leg/i) ?? torso;
  if (/shin|calf/i.test(layer)) return sameSide(/thigh|leg/i) ?? torso;
  if (/sword|blade|weapon|katana|axe|staff|spear|gun|shield/i.test(layer)) return find(/near.*(hand|arm)|(hand|arm).*near/i) ?? find(/hand|arm/i) ?? torso;
  if (/eye|mouth|face|hair|hat|helmet|ear/i.test(layer)) return find(/head/i) ?? torso;
  return torso;
}

/**
 * Suggested joint and end of each part at the base frame, from pixels: the joint is the part's pixel nearest its
 * parent's pixels (ties: the one nearest the parent's center), the end its pixel farthest from the joint. Silhouette
 * proximity, not anatomy: the caller stores them marked "derived" for the agent to check.
 */
export async function deriveJoints(doc: Document, parts: RigPart[], base: number): Promise<RigPart[]> {
  const masks = new Map<string, { pts: [number, number][]; cx: number; cy: number }>();
  for (const p of parts) {
    const img = await doc.pixels(p.layer, base);
    const pts: [number, number][] = [];
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] >= 128) pts.push([x, y]);
    const cx = pts.reduce((s, q) => s + q[0], 0) / Math.max(1, pts.length), cy = pts.reduce((s, q) => s + q[1], 0) / Math.max(1, pts.length);
    masks.set(p.layer, { pts, cx, cy });
  }
  return parts.map((p) => {
    if (p.joint && p.end) return p;
    const own = masks.get(p.layer)!;
    if (!own.pts.length) return p;
    const par = p.parent ? masks.get(p.parent) : undefined;
    let joint: [number, number];
    if (par?.pts.length) {
      let best = Infinity, bestTie = Infinity;
      joint = own.pts[0];
      for (const q of own.pts) {
        let d = Infinity;
        for (const r of par.pts) { const e = (q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2; if (e < d) d = e; }
        const tie = (q[0] - par.cx) ** 2 + (q[1] - par.cy) ** 2;
        if (d < best || (d === best && tie < bestTie)) { best = d; bestTie = tie; joint = q; }
      }
    } else {
      joint = [Math.round(own.cx), Math.round(own.cy)];
    }
    let end = joint, far = -1;
    for (const q of own.pts) { const e = (q[0] - joint[0]) ** 2 + (q[1] - joint[1]) ** 2; if (e > far) { far = e; end = q; } }
    return { ...p, joint: p.joint ?? joint, end: p.end ?? end, source: p.source ?? "derived" };
  });
}
