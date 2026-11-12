// The fresh-eyes critic and the blind A/B gate (#76).
//
// `critique` starts a fresh agent (the provider runner spawn_agents uses, on
// the critic's read-only MCP endpoint) that has not seen the conversation or
// the brief: it gets the sprite's images, its state, the rules index and at
// most a one-line "what this is". It answers in strict JSON (a cold read, a
// 0-10 score, findings tagged BLOCKING / WORTH FIXING / NOTE, each citing a
// `rule:<id>`), which is parsed, retried once when it does not parse, and
// checked against the rules index.
//
// `ab_compare` shows another fresh critic two versions in one image, labelled
// A and B in a random order that only the bridge knows, asks which is the
// better sprite, and maps the answer back. With a checkpoint the two versions
// are the canvas saved by `diff_visual save` and the canvas now, and the fix
// guard ("fix, don't redraw") runs first: a fix that changed more than a
// quarter of a layer's opaque pixels is refused before any critic runs.
//
// diff_visual's checkpoint lives in the extension and holds only the active
// frame's composite, so `diff_visual save` also keeps a copy here, per layer
// and frame (saveReviewCheckpoint), for the guard and the before image.
//
// Adapted from aseprite-ai-artist (MIT License, Copyright (c) 2026
// with-pebbly, https://github.com/with-pebbly/aseprite-ai-artist):
// agents/pixel-critic.md (the cold read before the brief, the severities, the
// 7/10 bar, comparison over scores) and skills/studio/SKILL.md step 8 (three
// rounds, a quarter of a layer, coin-flipped a.png/b.png). The prompts and
// code are our own.
import * as z from "zod/v4";
import type { ImageBlock } from "./attachments.js";
import { documentOf, resolveFrames, type SpriteInfo } from "./document.js";
import { blank, contactSheet, encodePng, flatten, sheetGeometry, type Rgba } from "./image.js";
import { encodeSnapshot } from "./png.js";
import { ruleIds, rulesIndex } from "./rules.js";
import { failure, text, type AsepriteRequester, type CriticSession, type Tool, type ToolContext, type ToolResult } from "./tool.js";
import { framesSpec } from "./tool_inputs.js";
import { MotionStore } from "./motion_clip.js";
import { MIN_SWING, measureWalk, type ContactReading } from "./walk_check.js";
import { SHEET_BACKDROP, SHEET_LABEL, snapshotView, VIEW_TARGET } from "./views.js";

/** A fix may change at most this share of a layer's opaque pixels (against the checkpoint). */
export const FIX_LIMIT = 0.25;
/** Changes this small always pass the guard, so a 3-pixel fix on a 10-pixel layer is not a "redraw". */
export const FIX_FLOOR = 8;
/** A draft ships at this score or better, with nothing BLOCKING. */
export const SHIP_SCORE = 7;
/** The longest "what this is" line: a name for the subject, not the brief. */
export const WHAT_MAX = 120;
/** At most this many frames per side in an A/B image. */
export const AB_FRAMES = 8;
/** A checkpoint keeps every frame while layers x frames stays under this; else only the active frame. */
const CHECKPOINT_CELLS = 256;

export const SEVERITIES = ["BLOCKING", "WORTH FIXING", "NOTE"] as const;
export type Severity = (typeof SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Prompts

export const CRITIC_PROMPT = `You are a pixel-art critic inside Aseprite. Another agent drew the sprite; you only judge it.
You have not been told the brief, and that is on purpose: say what the picture shows, not what it was meant to show.
You have read-only tools (snapshot with views, read_pixels, check, get_state, read_guide). You cannot and must not edit.
Never say "looks good". A finding names a place (coordinates, a part, a frame) and a concrete fix.
Your last message is the JSON object you were asked for, and nothing else.`;

const SEVERITY_TEXT = `Severities:
- BLOCKING: the sprite fails as it is: the subject does not read, a part floats or is cut off, broken frames, noise that reads as dirt across it, a mechanical error from check.
- WORTH FIXING: clearly better when fixed: flat or pillow shading, muddy values, stray pixels, uneven lines, near-duplicate colors.
- NOTE: small or a matter of taste.`;

/** The critique request: the critic's whole view of the work. */
export function critiqueMessage(o: { what?: string; state: string; images: string; index: string }): string {
  return [
    "Critique this sprite. The attached image shows it; " + o.images,
    o.what ? `The person who asked says it is: ${o.what}` : "You are not told what it is.",
    "",
    "Sprite state:",
    o.state,
    "",
    "Procedure:",
    "1. Cold read first: before anything else, write down in one or two sentences what the picture shows to someone never told what it is, and where the eye lands first.",
    "2. Run check for the mechanical findings. Use snapshot (view 'filmstrip' or 'onion' for animation; a single frame at full zoom for detail) and read_pixels for exact positions.",
    "3. Read the rules you judge against with read_guide (a chapter's Review and Mistakes sections, or one rule id). Every finding cites one rule id from the index below; when no rule fits exactly, cite the closest chapter's review or mistakes id. Never invent an id.",
    "4. Score 0-10: 7 or more means you would ship it in a game as it is. Do not round up.",
    "",
    SEVERITY_TEXT,
    "",
    "Rules index:",
    o.index,
    "",
    "Reply with only this JSON object (no prose around it, no code fence):",
    `{"cold_read": "<what you see>", "score": <0-10>, "findings": [{"severity": "BLOCKING" | "WORTH FIXING" | "NOTE", "rule": "rule:<id>", "where": "<coordinates, part or frame>", "issue": "<what is wrong>", "fix": "<the smallest change that fixes it>"}], "first_fix": "<the single most valuable fix>"}`,
  ].join("\n");
}

/** The A/B request: two versions, no brief, a forced choice. */
export function compareMessage(o: { what?: string; layout: string; index: string }): string {
  return [
    "Compare two versions of the same sprite. " + o.layout,
    o.what ? `The person who asked says it is: ${o.what}` : "You are not told what it is.",
    "Judge only these two images, as you see them: which is the better pixel art? You are not told which is older or which was changed, and the order is random. " +
      "Do not take a snapshot of the document: it shows only one of them and tells you nothing about the other.",
    "Look for: a silhouette that reads, parts that float or are cut off, stray pixels and noise, clean lines, shading with a clear light, readable values.",
    "You may read_guide the rules (index below) and cite ids from it.",
    "",
    "Rules index:",
    o.index,
    "",
    "Reply with only this JSON object (no prose around it, no code fence):",
    `{"cold_read_a": "<what A shows>", "cold_read_b": "<what B shows>", "winner": "A" | "B" | "tie", "reason": "<one line>", "rules": ["rule:<id>"]}`,
    "Pick tie only when you cannot tell them apart.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing

/** The JSON object in a reply: the reply itself, inside a code fence, or between its first { and last }. */
export function extractJson(reply: string): unknown {
  const tries: string[] = [];
  const t = reply.trim();
  tries.push(t);
  const fence = [...t.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  tries.push(...fence.reverse());
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  let last: unknown;
  for (const s of tries) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`no JSON object in the reply${last instanceof Error ? ` (${last.message})` : ""}`);
}

export interface Finding {
  severity: Severity;
  /** The cited id without "rule:", or "" when none was cited. */
  rule: string;
  /** The id is not in the rules index (or none was cited). */
  unknownRule: boolean;
  where: string;
  issue: string;
  fix: string;
}

export interface Critique {
  coldRead: string;
  score: number;
  findings: Finding[];
  firstFix: string;
  /** Score >= SHIP_SCORE and nothing BLOCKING. */
  ship: boolean;
  /** Cited ids that are not in the rules index. */
  unknownRules: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());

/** "rule:char.review", "`rule:char.review`", "char.review" -> "char.review". */
export function normalizeRuleId(v: unknown): string {
  return str(v).replace(/`/g, "").replace(/^rules?:\/*/i, "").replace(/^rules\//i, "").trim().toLowerCase();
}

export function normalizeSeverity(v: unknown): Severity | undefined {
  const s = str(v).toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : undefined;
}

/** A critic's reply as a Critique; throws with what is wrong, so the critic can be asked again. */
export function parseCritique(reply: string, known: Set<string> = ruleIds()): Critique {
  const o = extractJson(reply) as Record<string, unknown>;
  const coldRead = str(o.cold_read);
  if (!coldRead) throw new Error("cold_read is missing");
  const score = typeof o.score === "number" ? o.score : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error(`score must be a number from 0 to 10, got ${JSON.stringify(o.score)}`);
  if (!Array.isArray(o.findings)) throw new Error("findings must be an array");
  const findings: Finding[] = o.findings.map((f: any, i: number) => {
    const severity = normalizeSeverity(f?.severity);
    if (!severity) throw new Error(`findings[${i}].severity must be BLOCKING, WORTH FIXING or NOTE, got ${JSON.stringify(f?.severity)}`);
    const issue = str(f.issue);
    if (!issue) throw new Error(`findings[${i}].issue is missing`);
    const rule = normalizeRuleId(f.rule);
    return { severity, rule, unknownRule: !rule || !known.has(rule), where: str(f.where), issue, fix: str(f.fix) };
  });
  const order = (s: Severity) => SEVERITIES.indexOf(s);
  findings.sort((a, b) => order(a.severity) - order(b.severity));
  const unknownRules = [...new Set(findings.filter((f) => f.rule && f.unknownRule).map((f) => f.rule))];
  return {
    coldRead, score, findings, firstFix: str(o.first_fix), unknownRules,
    ship: score >= SHIP_SCORE && !findings.some((f) => f.severity === "BLOCKING"),
  };
}

export interface AbAnswer {
  winner: "A" | "B" | "tie";
  reason: string;
  coldReadA: string;
  coldReadB: string;
  rules: string[];
  unknownRules: string[];
}

export function parseAb(reply: string, known: Set<string> = ruleIds()): AbAnswer {
  const o = extractJson(reply) as Record<string, unknown>;
  const w = str(o.winner).toUpperCase();
  const winner = w === "A" || w === "B" ? w : w === "TIE" ? "tie" : undefined;
  if (!winner) throw new Error(`winner must be "A", "B" or "tie", got ${JSON.stringify(o.winner)}`);
  const rules = (Array.isArray(o.rules) ? o.rules : []).map(normalizeRuleId).filter(Boolean);
  return {
    winner, reason: str(o.reason), coldReadA: str(o.cold_read_a), coldReadB: str(o.cold_read_b),
    rules, unknownRules: rules.filter((r) => !known.has(r)),
  };
}

/**
 * Asks a critic session and parses the reply; on a parse failure asks once more in the same session, saying what
 * was wrong. Throws when the second reply does not parse either.
 */
export async function askParsed<T>(session: CriticSession, message: string, images: ImageBlock[], parse: (reply: string) => T): Promise<{ value: T; retried: boolean }> {
  const first = await session.ask(message, images);
  try {
    return { value: parse(first), retried: false };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const second = await session.ask(
      `Your reply could not be used: ${why}. Reply again with only the JSON object in the format asked for: no prose, no code fence.`);
    try {
      return { value: parse(second), retried: true };
    } catch (err2) {
      const why2 = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(`The critic's reply did not parse twice (${why2}). Last reply: ${second.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoints and the fix guard

export interface ReviewCheckpoint {
  name: string;
  title: string;
  width: number;
  height: number;
  frames: number[];
  /** The visible composite per frame. */
  composite: Map<number, Rgba>;
  /** Image layers by id: name and pixels per frame. */
  layers: Map<string, { name: string; images: Map<number, Rgba> }>;
  /** Timing at the checkpoint (#98): every frame's duration and the tags' ranges and playback direction. */
  durations?: number[];
  tags?: { name: string; from: number; to: number; direction?: string }[];
}

/**
 * What changed in timing since a checkpoint (#98): frame count, per-frame durations, and tag ranges or playback
 * direction. A timing-only fix changes no pixel, so the A/B would otherwise see "nothing changed".
 */
export function timingChanges(cp: Pick<ReviewCheckpoint, "durations" | "tags">, now: { durations: number[]; tags: { name: string; from: number; to: number; direction?: string }[] }): string[] {
  const out: string[] = [];
  if (!cp.durations) return out;
  if (cp.durations.length !== now.durations.length) out.push(`frames ${cp.durations.length} -> ${now.durations.length}`);
  for (let i = 0; i < Math.min(cp.durations.length, now.durations.length); i++) {
    if (cp.durations[i] !== now.durations[i]) out.push(`frame ${i + 1}: ${cp.durations[i]} -> ${now.durations[i]} ms`);
  }
  const key = (t: { from: number; to: number; direction?: string }) => `${t.from}-${t.to} ${t.direction ?? "forward"}`;
  const before = new Map((cp.tags ?? []).map((t) => [t.name, t]));
  for (const t of now.tags) {
    const b = before.get(t.name);
    if (!b) out.push(`tag ${t.name} added (${key(t)})`);
    else if (key(b) !== key(t)) out.push(`tag ${t.name}: ${key(b)} -> ${key(t)}`);
    before.delete(t.name);
  }
  for (const t of before.values()) out.push(`tag ${t.name} removed`);
  return out;
}

/** "durations 100, 100, 300 ms", or "100 ms each". */
const timingText = (d: number[]) => (d.length && d.every((x) => x === d[0]) ? `${d[0]} ms each` : `durations ${d.join(", ")} ms`);

/** One version's timing for the A/B critic: durations, and tags with their playback direction. */
export function describeTiming(d: number[], tags: { name: string; from: number; to: number; direction?: string }[]): string {
  const t = tags.map((x) => `${x.name} ${x.from}-${x.to}${x.direction && x.direction !== "forward" ? ` ${x.direction}` : ""}`);
  return `${timingText(d)}${t.length ? `, tags ${t.join(", ")}` : ""}`;
}

const checkpoints = new Map<string, ReviewCheckpoint>();
const MAX_CHECKPOINTS = 8;

export function reviewCheckpoint(name: string): ReviewCheckpoint | undefined {
  return checkpoints.get(name);
}

/**
 * Keeps a copy of the sprite for diff_visual's checkpoint `name`: the composite and every image layer, for every
 * frame (only the active one when the sprite is large). Returns undefined when there is no sprite to copy.
 */
export async function saveReviewCheckpoint(aseprite: AsepriteRequester, name: string): Promise<ReviewCheckpoint | undefined> {
  const doc = documentOf(aseprite);
  let info: SpriteInfo;
  try {
    info = await doc.info();
  } catch {
    return undefined;
  }
  if (!info.width || !info.height || !info.durations.length) return undefined;
  const imageLayers = info.layers.filter((l) => !l.group);
  const all = Array.from({ length: info.durations.length }, (_, i) => i + 1);
  const frames = (imageLayers.length + 1) * all.length <= CHECKPOINT_CELLS ? all : [info.frame];
  const cp: ReviewCheckpoint = {
    name, title: info.title, width: info.width, height: info.height, frames, composite: new Map(), layers: new Map(),
    durations: [...info.durations], tags: info.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
  };
  for (const f of frames) cp.composite.set(f, await doc.pixels(undefined, f));
  for (const l of imageLayers) {
    const images = new Map<number, Rgba>();
    for (const f of frames) {
      try {
        images.set(f, await doc.pixels(l.id, f));
      } catch {
        // A layer the snapshot can't render (a tilemap in an old build): not guarded.
      }
    }
    if (images.size) cp.layers.set(l.id, { name: l.name, images });
  }
  checkpoints.delete(name);
  checkpoints.set(name, cp);
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
  return cp;
}

/** Test hook: put a checkpoint in the store. */
export function __setReviewCheckpointForTest(cp: ReviewCheckpoint): void {
  checkpoints.set(cp.name, cp);
}

/** Pixels that differ (RGBA, transparent pixels all equal) and the opaque pixels of `before`. */
export function changedPixels(before: Rgba, after: Rgba): { changed: number; opaque: number } {
  let changed = 0, opaque = 0;
  const a = before.data, b = after.data;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    if (a[i + 3]) opaque++;
    if (!a[i + 3] && !b[i + 3]) continue;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
  }
  return { changed, opaque };
}

export interface LayerChange {
  id: string;
  name: string;
  changed: number;
  opaque: number;
  /** changed / opaque (Infinity when the layer was empty at the checkpoint and is not now). */
  share: number;
  /** Over the limit: the fix redrew this layer. */
  over: boolean;
  /** The layer is gone. */
  removed?: boolean;
}

export interface GuardResult {
  ok: boolean;
  layers: LayerChange[];
  /** Layers made after the checkpoint (not guarded). */
  added: string[];
  frames: number[];
}

/**
 * The fix guard: for every layer the checkpoint kept, the pixels changed since then against its opaque pixels at
 * the checkpoint (summed over the kept frames). A layer over FIX_LIMIT (and over FIX_FLOOR pixels) fails it, as
 * does a removed layer. A layer that was empty at the checkpoint, or is new, is not guarded: drawing on it is
 * adding, not redrawing.
 */
export function fixGuard(cp: ReviewCheckpoint, now: Map<string, { name: string; images: Map<number, Rgba> }>, limit = FIX_LIMIT): GuardResult {
  const layers: LayerChange[] = [];
  for (const [id, before] of cp.layers) {
    const after = now.get(id);
    let changed = 0, opaque = 0;
    for (const [f, img] of before.images) {
      const cur = after?.images.get(f) ?? blank(img.width, img.height);
      const d = changedPixels(img, cur);
      changed += d.changed;
      opaque += d.opaque;
    }
    if (!after) {
      layers.push({ id, name: before.name, changed: opaque, opaque, share: opaque ? 1 : 0, over: opaque > 0, removed: true });
      continue;
    }
    if (!opaque) {
      if (changed) layers.push({ id, name: before.name, changed, opaque, share: Infinity, over: false });
      continue;
    }
    const share = changed / opaque;
    layers.push({ id, name: before.name, changed, opaque, share, over: share > limit && changed > FIX_FLOOR });
  }
  const added = [...now.entries()].filter(([id]) => !cp.layers.has(id)).map(([id, l]) => `${id} ${l.name}`);
  return { ok: !layers.some((l) => l.over), layers, added, frames: cp.frames };
}

/** The layers' pixels now, for the frames a checkpoint kept. */
async function layersNow(aseprite: AsepriteRequester, cp: ReviewCheckpoint) {
  const doc = documentOf(aseprite);
  const info = await doc.info();
  const now = new Map<string, { name: string; images: Map<number, Rgba> }>();
  for (const l of info.layers.filter((x) => !x.group)) {
    const images = new Map<number, Rgba>();
    for (const f of cp.frames) {
      if (f > info.durations.length) continue;
      try {
        images.set(f, await doc.pixels(l.id, f));
      } catch {
        // not guarded, as when saving
      }
    }
    now.set(l.id, { name: l.name, images });
  }
  return now;
}

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "new");

export function formatGuard(g: GuardResult, checkpoint: string): string {
  const touched = g.layers.filter((l) => l.changed > 0);
  const lines = touched.map((l) => l.removed
    ? `- ${l.id} ${l.name}: removed (${l.opaque} opaque px at the checkpoint)`
    : `- ${l.id} ${l.name}: ${l.changed} px changed of ${l.opaque} opaque (${pct(l.share)})${l.over ? " OVER" : ""}`);
  if (g.added.length) lines.push(`- new since the checkpoint (not guarded): ${g.added.join(", ")}`);
  const head = g.ok
    ? `Fix guard passed against checkpoint "${checkpoint}": no layer changed more than ${pct(FIX_LIMIT)} of its opaque pixels.`
    : `Fix round refused: the fix redrew instead of fixing. ${g.layers.filter((l) => l.over).map((l) => `${l.id} ${l.name}`).join(", ")} ` +
      `changed more than ${pct(FIX_LIMIT)} of its opaque pixels since checkpoint "${checkpoint}". Revert to the checkpoint (undo the fix), ` +
      "then change only the pixels the finding points at.";
  return [head, ...(touched.length || g.added.length ? lines : ["- nothing changed"])].join("\n");
}

/**
 * A named checkpoint of the active sprite (#92): with chats per sprite, the same name can be saved on another
 * sprite, and comparing across sprites would guard the wrong pixels.
 */
async function checkpointOfActive(aseprite: AsepriteRequester, name: string): Promise<ReviewCheckpoint> {
  const cp = checkpoints.get(name);
  if (!cp) throw new Error(`No checkpoint named "${name}" in the bridge: save one with diff_visual { save: "${name}" } before the fix.`);
  const title = (await documentOf(aseprite).infoOrNone())?.title;
  if (title !== undefined && title !== cp.title) {
    throw new Error(`Checkpoint "${name}" was saved on sprite "${cp.title}", not "${title}"; save one on this sprite first.`);
  }
  return cp;
}

/** Runs the guard for a named checkpoint. */
export async function runFixGuard(aseprite: AsepriteRequester, name: string): Promise<GuardResult> {
  const cp = await checkpointOfActive(aseprite, name);
  return fixGuard(cp, await layersNow(aseprite, cp));
}

// ---------------------------------------------------------------------------
// Images

const pngBlock = (img: Rgba, label: string): ImageBlock => ({ label, mimeType: "image/png", data: encodePng(img).toString("base64") });

/** A short description of the sprite for the critic: size, mode, frames, tags, layers, palette. */
export function stateSummary(info: SpriteInfo): string {
  const n = info.durations.length;
  const durs = [...new Set(info.durations)];
  return [
    `${info.width}x${info.height} px, ${info.colorMode}, ${n} frame${n === 1 ? "" : "s"}` +
      (n > 1 ? ` (${durs.length === 1 ? `${durs[0]} ms each` : `durations ${info.durations.join(", ")} ms`})` : "") + ".",
    info.tags.length ? `Tags: ${info.tags.map((t) => `${t.name} ${t.from}-${t.to}`).join(", ")}.` : "No tags.",
    `Layers (top first): ${info.layers.map((l) => `${l.id} ${l.path.length ? `${l.path.join("/")}/` : ""}${l.name}${l.group ? " (group)" : ""}${l.visible ? "" : " (hidden)"}`).join(", ")}.`,
    `Palette: ${info.palette.length} colors.`,
  ].join("\n");
}

/** Two rows of frames, A on top and B below, on the sheet backdrop, at the largest zoom that fits about 1024 px. */
export function abSheet(a: Rgba[], b: Rgba[]): { image: Rgba; zoom: number } {
  const w = a[0].width, h = a[0].height;
  const cols = Math.max(a.length, b.length);
  let zoom = Math.max(1, Math.min(16, Math.floor(256 / Math.max(w, h))));
  for (; zoom > 1; zoom--) {
    const g = sheetGeometry(cols * 2, w, h, { columns: cols, zoom });
    if (g.width <= VIEW_TARGET && g.height <= VIEW_TARGET) break;
  }
  const cell = Math.max(1, Math.ceil(4 / zoom));
  const row = (imgs: Rgba[], letter: string) => Array.from({ length: cols }, (_, i) => imgs[i]
    ? { img: flatten(imgs[i], "checker", cell), label: imgs.length > 1 ? `${letter}${i + 1}` : letter }
    : { img: blank(w, h), label: "" });
  const cells = [...row(a, "A"), ...row(b, "B")];
  const image = contactSheet(cells.map((c) => c.img), {
    labels: cells.map((c) => c.label), columns: cols, zoom, background: SHEET_BACKDROP, labelColor: SHEET_LABEL,
  });
  return { image, zoom };
}

/** mulberry32: a small seeded generator for tests (ctx.random). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// A/B records

export interface AbRecord {
  id: number;
  /** Which input each shown label was: shown.A === "a" means A showed the caller's a (or the checkpoint). */
  shown: { A: "a" | "b"; B: "a" | "b" };
  winner?: "a" | "b" | "tie";
  at: number;
}

const comparisons: AbRecord[] = [];
let nextComparison = 1;

/** The recorded A/B mappings, newest last (kept for the last 20 comparisons). */
export function abRecords(): readonly AbRecord[] {
  return comparisons;
}

/** Draws the blind order and records it; only the bridge sees it until the verdict. */
export function drawOrder(random: () => number): AbRecord {
  const flip = random() < 0.5;
  const rec: AbRecord = { id: nextComparison++, shown: flip ? { A: "b", B: "a" } : { A: "a", B: "b" }, at: Date.now() };
  comparisons.push(rec);
  while (comparisons.length > 20) comparisons.shift();
  return rec;
}

/** The critic's A/B/tie as the caller's a/b/tie. */
export function mapBack(rec: AbRecord, winner: "A" | "B" | "tie"): "a" | "b" | "tie" {
  rec.winner = winner === "tie" ? "tie" : rec.shown[winner];
  return rec.winner;
}

// ---------------------------------------------------------------------------
// Tools

const what = z.string().max(WHAT_MAX).optional()
  .describe(`At most a one-line name for the subject, e.g. 'a 32x32 knight walk cycle'. Not the brief: the critic judges what it sees.`);

const side = z.object({
  layer: z.string().optional().describe("Layer id or name. Default: the whole sprite."),
  frame: z.number().int().min(1).optional().describe("One frame. Default: the active frame."),
  frames: framesSpec.optional().describe("Several frames: [1,2] or '1-4' (at most 8 are shown)."),
}).strict();

async function openCritic(ctx: ToolContext, label: string): Promise<CriticSession | undefined> {
  return ctx.critic?.open(label);
}

async function sideImages(ctx: ToolContext, info: SpriteInfo, s: z.infer<typeof side>): Promise<{ images: Rgba[]; frames: number[] }> {
  const doc = documentOf(ctx);
  const n = info.durations.length;
  const frames = (s.frames !== undefined ? resolveFrames(s.frames, n, info.frame, "all") : [s.frame ?? info.frame]).slice(0, AB_FRAMES);
  for (const f of frames) if (f < 1 || f > n) throw new Error(`Frame ${f} is out of range (1-${n})`);
  const images: Rgba[] = [];
  for (const f of frames) images.push(await doc.pixels(s.layer, f));
  return { images, frames };
}

const sideName = (s: z.infer<typeof side>, frames: number[]) =>
  `${s.layer ? `layer "${s.layer}"` : "the sprite"}, frame${frames.length > 1 ? "s" : ""} ${frames.join(",")}`;


// ---------------------------------------------------------------------------
// Motion review (#99): what a viewer sees on a walk's contacts, against what walk_check measured

export type Side = "forward" | "back" | "unclear";
/** What a viewer sees on one contact: the arm that stands out, and the leg that reads as on that arm's side. */
export interface SeenContact { label: string; arm: Side; sameSideLeg: Side; pairing: string; sure: boolean }

/** The motion review request: two contact frames, the facing, and only how a player pairs the limbs. */
export function motionMessage(facing: "right" | "left"): string {
  return [
    `The image shows two frames of a side-view walk, labeled A (left) and B (right). The character faces ${facing} ` +
      `(forward = toward the ${facing} edge). Both are contact poses: one foot forward, one back. The checker is transparency.`,
    "Answer only from what you see at a glance, as a player would, for each frame:",
    "- arm: the arm you notice first (the one that reads as an arm on the body's visible side). Is its hand forward or back " +
      "of the shoulder? 'unclear' when no arm reads, or it hangs straight.",
    "- same_side_leg: the leg that looks like it belongs to the same side of the body as that arm (by its color, value, " +
      "outline or which one is drawn in front). Is its foot forward or back? 'unclear' when you can't pair them.",
    "- pairing: what made you pair that arm with that leg.",
    "- sure: false when another player could reasonably pair that arm with the other leg (the cues disagree: one says " +
      "this leg, another that one); true only when every cue points to the same leg.",
    "Don't use tools; judge the image.",
    "Reply with only this JSON object (no prose around it, no code fence):",
    `{"frames": [{"label": "A", "arm": "forward" | "back" | "unclear", "same_side_leg": "forward" | "back" | "unclear", "pairing": "<why>", "sure": true | false}, {"label": "B", ...}]}`,
  ].join("\n");
}

const sideOf = (v: unknown): Side | undefined => (v === "forward" || v === "back" || v === "unclear" ? v : undefined);

export function parseMotion(reply: string): SeenContact[] {
  const o = extractJson(reply) as Record<string, unknown>;
  if (!Array.isArray(o.frames) || o.frames.length !== 2) throw new Error("frames must be an array of two entries (A and B)");
  return o.frames.map((f: any, i: number) => {
    const arm = sideOf(f?.arm), sameSideLeg = sideOf(f?.same_side_leg);
    if (!arm) throw new Error(`frames[${i}].arm must be forward, back or unclear`);
    if (!sameSideLeg) throw new Error(`frames[${i}].same_side_leg must be forward, back or unclear`);
    return { label: String(f?.label ?? (i ? "B" : "A")), arm, sameSideLeg, pairing: typeof f?.pairing === "string" ? f.pairing : "", sure: f?.sure !== false };
  });
}

/**
 * How a player pairs the limbs against what was measured, per contact. An arm seen swinging with the leg it is paired
 * with is the error a player sees, whatever the layers say; a pairing that differs from the named near arm and near
 * leg, or none at all, is a readability finding (the depth cue between near and far limbs doesn't read).
 */
export function compareMotion(measured: ContactReading[], seen: SeenContact[]): string[] {
  const findings: string[] = [];
  const m = (o?: number): Side => (o === undefined || Math.abs(o) < MIN_SWING ? "unclear" : o > 0 ? "forward" : "back");
  const cue = "Give the near arm and the near leg the same depth cue: both the lighter step (or both outlined, drawn " +
    "over the body), and the far arm and far leg both the darker step, so a player pairs them by side.";
  measured.forEach((c, i) => {
    const v = seen[i];
    if (!v) return;
    const why = v.pairing ? ` (paired by: ${v.pairing})` : "";
    if (v.arm !== "unclear" && v.arm === v.sameSideLeg) {
      findings.push(`frame ${c.frame}: a player sees the arm swing ${v.arm} with the leg on its side${why}. ${cue}`);
    } else if (v.arm === "unclear" || v.sameSideLeg === "unclear" || !v.sure) {
      findings.push(`frame ${c.frame}: a player can't tell which arm goes with which leg${why}. ${cue}`);
    } else if (v.arm !== m(c.arm.offset) || v.sameSideLeg !== m(c.leg.offset)) {
      findings.push(`frame ${c.frame}: a player reads the far limbs as the near ones (arm ${v.arm}, leg ${v.sameSideLeg}; ` +
        `the near arm is ${m(c.arm.offset)}, the near leg ${m(c.leg.offset)})${why}. ${cue}`);
    }
  });
  return findings;
}

export const CRITIC_TOOLS: Tool[] = [
  {
    name: "motion_review",
    title: "Walk motion review",
    description:
      "A fresh critic looks at a walk's two contact frames (enlarged, no measurements, no brief) and says which arm it " +
      "notices, which leg it pairs with that arm, and which way each points. An arm seen swinging with its paired leg, " +
      "no pairing, or a pairing that differs from the near limbs walk_check measured is a finding with the fix. Use it after walk_check says ok: the poses can be right while the depth doesn't read. " +
      "Costs a model call.",
    input: z.object({
      tag: z.string().optional().describe("The walk's tag. Default: the one walk_check stored, else 'walk'."),
    }),
    kind: "read",
    label: () => "Ask a critic how the walk reads",
    async run(input, ctx) {
      if (!ctx.critic) return failure("The critic is not available in this bridge (it needs the chat's agent provider).");
      const doc = documentOf(ctx);
      let measure;
      try {
        measure = await measureWalk(doc, { tag: input.tag }, (await MotionStore.load(doc)).walkContract(input.tag));
      } catch (e) {
        return failure(`${(e as Error).message} (motion_review uses the limbs walk_check stored.)`);
      }
      const { contract, readings, verdict } = measure;
      const frames: Rgba[] = [];
      for (const f of contract.contacts) frames.push(await doc.pixels(undefined, f));
      const { width: w, height: h } = frames[0];
      let zoom = Math.max(1, Math.min(16, Math.floor(320 / Math.max(w, h))));
      for (; zoom > 1; zoom--) {
        const g = sheetGeometry(2, w, h, { columns: 2, zoom });
        if (g.width <= VIEW_TARGET && g.height <= VIEW_TARGET) break;
      }
      const cell = Math.max(1, Math.ceil(4 / zoom));
      const sheet = contactSheet(frames.map((f) => flatten(f, "checker", cell)), {
        labels: ["A", "B"], columns: 2, zoom, background: SHEET_BACKDROP, labelColor: SHEET_LABEL,
      });
      const session = await openCritic(ctx, "motion critic");
      if (!session) return failure("The critic is not available in this bridge.");
      let seen;
      try {
        seen = await askParsed(session, motionMessage(contract.facing),
          [{ label: "contacts", mimeType: "image/png", data: encodePng(sheet).toString("base64") }], parseMotion);
      } finally {
        session.close();
      }
      const findings = [...verdict.errors.map((e) => `measured: ${e}`), ...compareMotion(readings, seen.value)];
      const status = verdict.errors.length ? "errors" : findings.length ? "readability" : "ok";
      return {
        content: [text([
          `MOTION REVIEW: ${status}`,
          `Contacts ${contract.contacts.join(" and ")} of "${contract.tag}", facing ${contract.facing}; walk_check: ${verdict.status}.`,
          ...seen.value.map((v, i) => `A player sees frame ${contract.contacts[i]}: the arm ${v.arm}, the leg on its side ${v.sameSideLeg}${v.pairing ? ` (paired by: ${v.pairing})` : ""}.`),
          ...findings.map((f) => `- ${f}`),
          status === "ok" ? "The walk reads as drawn." : "Fix these, then walk_check and motion_review again.",
        ].join("\n"))],
      };
    },
  },
  {
    name: "critique",
    title: "Fresh-eyes critique",
    description:
      "Have the sprite judged by a fresh critic agent that has not seen this conversation or the brief (read-only tools, the " +
      "pixel-art rules). It returns a cold read (what the picture shows to a stranger), a score out of 10 and findings tagged " +
      "BLOCKING / WORTH FIXING / NOTE, each citing a rule id. The work ships at 7/10 or better with nothing BLOCKING. Pass at " +
      "most a one-line `what`; never the brief. With `checkpoint` (a diff_visual save taken before a fix) the fix guard runs " +
      "first: a fix that changed more than 25% of a layer's opaque pixels is refused without a critique. Costs a model call: use " +
      "it for sizable work (the review skill).",
    input: z.object({
      what,
      frames: framesSpec.optional().describe("Frames to show: [1,2] or '1-4'. Default: all frames (one frame: just it)."),
      tag: z.string().optional().describe("Show this tag's frames."),
      layer: z.string().optional().describe("Judge only this layer. Default: the whole sprite."),
      checkpoint: z.string().optional().describe("Run the fix guard against this diff_visual checkpoint first."),
    }),
    kind: "read",
    label: () => "Ask a fresh critic",
    async run(input, ctx) {
      let guardText = "";
      if (input.checkpoint !== undefined) {
        const g = await runFixGuard(ctx, input.checkpoint);
        guardText = formatGuard(g, input.checkpoint);
        if (!g.ok) return { content: [text(`${guardText}\nNo critique was run for this round.`)] };
      }
      if (!ctx.critic) return failure("The critic is not available in this bridge (it needs the chat's agent provider).");
      const doc = documentOf(ctx);
      const info = await doc.info();
      const n = info.durations.length;
      const many = input.tag !== undefined || (input.frames !== undefined ? resolveFrames(input.frames, n, info.frame, "all").length > 1 : n > 1);
      let image: ImageBlock, shows: string;
      if (many) {
        const r = await snapshotView(ctx, { view: "filmstrip", tag: input.tag, frames: input.frames, layer: input.layer });
        if (r.isError) return r;
        const img = r.content.find((c) => c.type === "image");
        if (!img || img.type !== "image") return failure("No filmstrip image");
        image = { label: "filmstrip", mimeType: img.mimeType, data: img.data };
        shows = "a filmstrip of the frames, numbered, read left to right.";
      } else {
        const frame = input.frames !== undefined ? resolveFrames(input.frames, n, info.frame, "all")[0] : info.frame;
        const px = await doc.pixels(input.layer, frame);
        const s = Math.max(1, Math.floor(512 / Math.max(info.width, info.height)));
        image = { label: "sprite", mimeType: "image/png", data: encodeSnapshot(Buffer.from(px.data), px.width, px.height, s, "checker").toString("base64") };
        shows = `frame ${frame}${input.layer ? ` of layer "${input.layer}"` : ""} at ${s}x on a checker (the checker is transparency).`;
      }
      const session = await openCritic(ctx, "critic");
      if (!session) return failure("The critic is not available in this bridge.");
      let parsed;
      try {
        const known = ruleIds();
        parsed = await askParsed(session, critiqueMessage({ what: input.what, state: stateSummary(info), images: shows, index: rulesIndex() }),
          [image], (r) => parseCritique(r, known));
      } finally {
        session.close();
      }
      return { content: [text([formatCritique(parsed.value, parsed.retried), guardText].filter(Boolean).join("\n\n"))] };
    },
  },
  {
    name: "ab_compare",
    title: "Blind A/B comparison",
    description:
      "Ask a fresh critic which of two versions is the better pixel art, blind: they are shown as A and B in a random order " +
      "only the bridge knows, and the answer is mapped back after the verdict. With `checkpoint` (a diff_visual save taken " +
      "before a fix) the versions are the checkpoint and the canvas now: the fix guard runs first (more than 25% of a layer's " +
      "opaque pixels changed refuses the round), then the changed frames are compared; keep the fix only when it wins, " +
      "otherwise undo it. Or compare `a` and `b`: a layer and frames each. Pass at most a one-line `what`, never the brief.",
    input: z.object({
      checkpoint: z.string().optional().describe("Compare this diff_visual checkpoint (before) with the canvas now (after)."),
      frames: framesSpec.optional().describe("checkpoint: frames to compare. Default: the frames that changed (at most 8)."),
      a: side.optional().describe("The first version: { layer, frame | frames }."),
      b: side.optional().describe("The second version."),
      what,
    }),
    kind: "read",
    label: () => "Blind A/B comparison",
    async run(input, ctx) {
      const doc = documentOf(ctx);
      let A: Rgba[], B: Rgba[], nameA: string, nameB: string, guardText = "";
      let timingSides: { a: string; b: string } | undefined;
      if (input.checkpoint !== undefined) {
        if (input.a || input.b) return failure("Pass checkpoint, or a and b, not both.");
        let cp: ReviewCheckpoint;
        try {
          cp = await checkpointOfActive(ctx, input.checkpoint);
        } catch (e) {
          return failure((e as Error).message);
        }
        const g = fixGuard(cp, await layersNow(ctx, cp));
        guardText = formatGuard(g, input.checkpoint);
        if (!g.ok) return { content: [text(`${guardText}\nNo comparison was run for this round.`)] };
        const info = await doc.info();
        if (info.width !== cp.width || info.height !== cp.height) return failure(`The canvas changed size since checkpoint "${cp.name}"; compare a and b instead.`);
        const now = new Map<number, Rgba>();
        for (const f of cp.frames) if (f <= info.durations.length) now.set(f, await doc.pixels(undefined, f));
        let frames: number[];
        const timing = timingChanges(cp, info);
        if (timing.length) timingSides = { a: describeTiming(cp.durations ?? [], cp.tags ?? []), b: describeTiming(info.durations, info.tags) };
        if (input.frames !== undefined) {
          frames = resolveFrames(input.frames, info.durations.length, info.frame, "all").filter((f) => cp.composite.has(f) && now.has(f));
          if (!frames.length) return failure(`Checkpoint "${cp.name}" kept frames ${cp.frames.join(",")} only.`);
        } else {
          frames = [...now.keys()].filter((f) => changedPixels(cp.composite.get(f)!, now.get(f)!).changed > 0);
          // A timing-only change: compare every kept frame, with the timing in the prompt.
          if (!frames.length && timing.length) frames = [...now.keys()];
          if (!frames.length) return { content: [text(`Nothing changed since checkpoint "${cp.name}"; there is nothing to compare.`)] };
        }
        frames = frames.slice(0, AB_FRAMES);
        A = frames.map((f) => cp.composite.get(f)!);
        B = frames.map((f) => now.get(f)!);
        nameA = `checkpoint "${cp.name}" (before the fix)`;
        nameB = "the canvas now (after the fix)";
      } else {
        if (!input.a || !input.b) return failure("Pass checkpoint, or both a and b.");
        const info = await doc.info();
        const sa = await sideImages(ctx, info, input.a), sb = await sideImages(ctx, info, input.b);
        A = sa.images; B = sb.images;
        nameA = `a (${sideName(input.a, sa.frames)})`;
        nameB = `b (${sideName(input.b, sb.frames)})`;
      }
      if (!ctx.critic) return failure("The critic is not available in this bridge (it needs the chat's agent provider).");
      const rec = drawOrder(ctx.random ?? Math.random);
      const shownA = rec.shown.A === "a" ? A : B, shownB = rec.shown.B === "a" ? A : B;
      const { image, zoom } = abSheet(shownA, shownB);
      // Timing per shown version, in the shown order, so the comparison stays blind (#98).
      const timingLine = timingSides
        ? ` The versions play with different timing: A ${rec.shown.A === "a" ? timingSides.a : timingSides.b}; B ${rec.shown.A === "a" ? timingSides.b : timingSides.a}. Judge the motion with that timing, not only the poses.`
        : "";
      const layout = (shownA.length > 1 || shownB.length > 1
        ? `The attached image has two rows at ${zoom}x on a checker (the checker is transparency): the top row is version A (frames A1, A2, ...), the bottom row is version B, frame for frame.`
        : `The attached image shows version A on top and version B below, at ${zoom}x on a checker (the checker is transparency).`) + timingLine;
      const session = await openCritic(ctx, "A/B critic");
      if (!session) return failure("The critic is not available in this bridge.");
      let parsed;
      try {
        const known = ruleIds();
        parsed = await askParsed(session, compareMessage({ what: input.what, layout, index: rulesIndex() }), [pngBlock(image, "a/b")], (r) => parseAb(r, known));
      } finally {
        session.close();
      }
      const v = parsed.value;
      const won = mapBack(rec, v.winner);
      const pick = (x: "a" | "b") => (x === "a" ? nameA : nameB);
      const shownAs = (x: "a" | "b") => (rec.shown.A === x ? "A" : "B");
      const verdict = won === "tie"
        ? `Verdict: tie; the critic could not tell them apart.`
        : `Verdict: ${pick(won)} is better (shown to the critic as ${shownAs(won)}).`;
      const action = input.checkpoint === undefined ? ""
        : won === "b" ? "Keep the fix."
        : "The fix did not win: undo it (back to the checkpoint) and try a different, smaller fix, or stop.";
      const lines = [
        `${verdict} ${action}`.trim(),
        v.reason ? `Why: ${v.reason}` : "",
        v.coldReadA || v.coldReadB ? `Cold reads: ${shownAs("a") === "A" ? nameA : nameB} — ${v.coldReadA}; ${shownAs("a") === "A" ? nameB : nameA} — ${v.coldReadB}` : "",
        v.rules.length ? `Rules: ${v.rules.map((r) => `rule:${r}${v.unknownRules.includes(r) ? " (unknown id)" : ""}`).join(", ")}` : "",
        `Blind order (comparison #${rec.id}): A was ${pick(rec.shown.A)}, B was ${pick(rec.shown.B)}.${parsed.retried ? " The critic's first reply did not parse; it was asked once more." : ""}`,
        guardText,
      ].filter(Boolean);
      return { content: [text(lines.join("\n"))] };
    },
  },
];

/** The critique as the caller reads it. */
export function formatCritique(c: Critique, retried = false): string {
  const blocking = c.findings.filter((f) => f.severity === "BLOCKING").length;
  const head = `Critique: ${c.score}/10. ${c.ship
    ? "Ship it: 7/10 or better with nothing BLOCKING."
    : `Not ready: ${blocking ? `${blocking} BLOCKING finding${blocking === 1 ? "" : "s"}` : `under ${SHIP_SCORE}/10`} (ships at ${SHIP_SCORE}/10 with nothing BLOCKING).`}`;
  const lines = [head, `Cold read: ${c.coldRead}`];
  for (const s of SEVERITIES) {
    const fs = c.findings.filter((f) => f.severity === s);
    if (!fs.length) continue;
    lines.push(s);
    for (const f of fs) {
      const rule = !f.rule ? "no rule cited" : f.unknownRule ? `rule:${f.rule} (unknown rule id)` : `rule:${f.rule}`;
      lines.push(`- [${rule}]${f.where ? ` ${f.where}:` : ""} ${f.issue}${f.fix ? `\n  fix: ${f.fix}` : ""}`);
    }
  }
  if (!c.findings.length) lines.push("No findings.");
  if (c.firstFix) lines.push(`First fix: ${c.firstFix}`);
  if (c.unknownRules.length) lines.push(`Unknown rule ids (not in the rules index; judge those findings yourself): ${c.unknownRules.map((r) => `rule:${r}`).join(", ")}`);
  if (retried) lines.push("The critic's first reply did not parse; it was asked once more.");
  return lines.join("\n");
}
