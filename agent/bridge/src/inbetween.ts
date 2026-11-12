// Key-to-key inbetweener (#110): the frames between two approved keys made by tools, not drawn. Each part (a layer)
// is solved as the rigid move (a turn and a shift) that best maps its key-A drawing onto its key-B drawing, relative
// to its parent's move. A turn is a rotation about a fixed point, its joint (a shoulder, a hip), so sampling the
// turn at a fraction of the angle puts the part on an arc about that joint; a child rides on its parent's move, so
// joints stay joined. Followers (hair, a cape) lag. Every pixel is a source color (RotSprite-style transform), and
// keys are never written.
import { ease, transform, type Easing } from "./animation.js";
import type { Rgba } from "./image.js";

const OPAQUE = 128;
type Pt = [number, number];

/** A rigid map p -> R(angle) p + t (angle in degrees, clockwise with y down). */
export interface Rigid { angle: number; t: Pt; }

export const IDENTITY: Rigid = { angle: 0, t: [0, 0] };

export function apply(m: Rigid, p: Pt): Pt {
  const a = (m.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[1] + m.t[0], s * p[0] + c * p[1] + m.t[1]];
}

/** a after b: p -> a(b(p)). */
export function compose(a: Rigid, b: Rigid): Rigid {
  return { angle: a.angle + b.angle, t: apply(a, b.t) };
}

export function invert(m: Rigid): Rigid {
  const back: Rigid = { angle: -m.angle, t: [0, 0] };
  const t = apply(back, m.t);
  return { angle: -m.angle, t: [-t[0], -t[1]] };
}

/** The image moved by a rigid map (RotSprite-style: clean edges, source colors only). */
export function render(img: Rgba, m: Rigid): Rgba {
  if (Math.abs(m.angle) < 1e-6 && Math.abs(m.t[0]) < 1e-6 && Math.abs(m.t[1]) < 1e-6) return img;
  return transform(img, { angle: m.angle, px: 0, py: 0, dx: m.t[0], dy: m.t[1] });
}

/** Opaque pixel centers of an image. */
export function points(img: Rgba): Pt[] {
  const out: Pt[] = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3] >= OPAQUE) out.push([x + 0.5, y + 0.5]);
  return out;
}

const centroid = (pts: Pt[]): Pt => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

/** A rotation by `deg` about the point c that also takes c to d. */
function about(deg: number, c: Pt, d: Pt): Rigid {
  const r = apply({ angle: deg, t: [0, 0] }, c);
  return { angle: deg, t: [d[0] - r[0], d[1] - r[1]] };
}

/** Overlap (intersection over union) of the points moved by m against the pixel set b. */
function overlap(a: Pt[], m: Rigid, b: Set<number>, w: number, h: number): number {
  let hit = 0;
  const seen = new Set<number>();
  for (const p of a) {
    const q = apply(m, p);
    const x = Math.floor(q[0]), y = Math.floor(q[1]);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (seen.has(k)) continue;
    seen.add(k);
    if (b.has(k)) hit++;
  }
  return hit / (seen.size + b.size - hit || 1);
}

/**
 * The rigid map that best takes drawing A onto drawing B: a turn (searched in 5° then 1° steps) about A's centroid
 * that puts the centroid on B's (refined by a pixel either way), and how well it fits (intersection over union).
 */
export function solveRigid(a: Rgba, b: Rgba): { map: Rigid; fit: number } {
  const pa = points(a), pbList = points(b);
  if (!pa.length || !pbList.length) return { map: IDENTITY, fit: 0 };
  const pb = new Set(pbList.map(([x, y]) => Math.floor(y) * b.width + Math.floor(x)));
  const ca = centroid(pa), cb = centroid(pbList);
  const score = (deg: number, off: Pt = [0, 0]) => {
    const m = about(deg, ca, [cb[0] + off[0], cb[1] + off[1]]);
    return { map: m, fit: overlap(pa, m, pb, b.width, b.height), deg };
  };
  // A thin part fits a range of turns equally well (pixels round): take the middle of the best range, not an edge.
  const middle = (cands: { map: Rigid; fit: number; deg: number }[]) => {
    const top = Math.max(...cands.map((c) => c.fit));
    const tied = cands.filter((c) => c.fit >= top - 1e-9);
    // No turn when no turn fits as well: a part that only slides must not wobble.
    return tied.find((c) => c.deg === 0) ?? tied[Math.floor((tied.length - 1) / 2)];
  };
  const coarse = middle(Array.from({ length: 72 }, (_, i) => score(-180 + i * 5)));
  const fine = middle(Array.from({ length: 21 }, (_, i) => score(((coarse.deg - 10 + i + 540) % 360) - 180)));
  let best = fine;
  for (const ox of [-1, -0.5, 0, 0.5, 1]) for (const oy of [-1, -0.5, 0, 0.5, 1]) {
    const c = score(fine.deg, [ox, oy]);
    if (c.fit > best.fit + 1e-9) best = c;
  }
  return { map: best.map, fit: Math.round(best.fit * 100) / 100 };
}

/**
 * The map at fraction e (0..1) of a rigid move: a turn of angle*e about the move's fixed point (its joint), so the
 * part travels on an arc; a move with almost no turn slides straight.
 */
export function partial(m: Rigid, e: number): Rigid {
  if (Math.abs(m.angle) < 1.5) return { angle: m.angle * e, t: [m.t[0] * e, m.t[1] * e] };
  return about(m.angle * e, pivotOf(m), pivotOf(m));
}

/** The fixed point of a turn (where R p + t = p): the joint the part turns about. */
export function pivotOf(m: Rigid): Pt {
  const a = (m.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // (I - R) p = t
  const a11 = 1 - c, a12 = s, a21 = -s, a22 = 1 - c;
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-9) return [0, 0];
  return [(m.t[0] * a22 - a12 * m.t[1]) / det, (a11 * m.t[1] - a21 * m.t[0]) / det];
}

export interface PartKeys {
  layer: string;
  parent?: string;
  /** Lag in frames (a follower: hair, a cape). */
  lag?: number;
  a: Rgba;
  b: Rgba;
}

export interface PartSolution {
  layer: string;
  parent?: string;
  lag: number;
  /** Key A to key B relative to the parent's move. */
  rel: Rigid;
  /** Its turn in degrees, and the joint it turns about at key A (undefined for a straight slide). */
  angle: number;
  joint?: Pt;
  fit: number;
  empty?: boolean;
}

/** Solves each part between its keys, parents before children (the order given, root first). */
export function solveParts(parts: PartKeys[]): PartSolution[] {
  const full = new Map<string, Rigid>();
  return parts.map((p) => {
    const parent = p.parent ? full.get(p.parent) : undefined;
    // Key B seen without the parent's move: what this part did on its own.
    const b = parent ? render(p.b, invert(parent)) : p.b;
    const { map, fit } = solveRigid(p.a, b);
    const empty = !points(p.a).length || !points(p.b).length;
    full.set(p.layer, parent ? compose(parent, map) : map);
    return {
      layer: p.layer, parent: p.parent, lag: p.lag ?? 0, rel: map, angle: Math.round(map.angle), fit,
      ...(Math.abs(map.angle) >= 1.5 ? { joint: pivotOf(map).map((v) => Math.round(v * 10) / 10) as Pt } : {}),
      ...(empty ? { empty: true } : {}),
    };
  });
}

/**
 * The in-between images of every part at the times `ts` (each 0 < t < 1). A part's map at time t is its parent's map
 * then its own partial move; the first half transforms key A's drawing forward, the second key B's drawing back from
 * the end, so each key's shape stays near its own key.
 */
export function inbetweens(parts: PartKeys[], sol: PartSolution[], ts: number[], o: { easing?: Easing; arc?: number; lagStep?: number } = {}): Map<string, Rgba[]> {
  const out = new Map<string, Rgba[]>();
  const keys = new Map(parts.map((p) => [p.layer, p]));
  const push = (layer: string, img: Rgba) => (out.get(layer) ?? out.set(layer, []).get(layer)!).push(img);
  // Each part's whole move from key A to key B (parent's then its own).
  const whole = new Map<string, Rigid>();
  for (const s of sol) whole.set(s.layer, s.parent && whole.has(s.parent) ? compose(whole.get(s.parent)!, s.rel) : s.rel);
  for (const t of ts) {
    const now = new Map<string, Rigid>();
    for (const s of sol) {
      const k = keys.get(s.layer)!;
      // A follower lags: its time runs behind and catches up at key B.
      const share = Math.min(0.9, s.lag * (o.lagStep ?? 0));
      const tt = share > 0 ? Math.max(0, (t - share) / (1 - share)) : t;
      const e = ease(tt, o.easing ?? "ease-in-out");
      let own = partial(s.rel, e);
      // A root's path bends upward by `arc` px at the middle (a hop): on top of its own move.
      if (!s.parent && o.arc) own = compose({ angle: 0, t: [0, -(o.arc * 4 * e * (1 - e))] }, own);
      const m = s.parent && now.has(s.parent) ? compose(now.get(s.parent)!, own) : own;
      now.set(s.layer, m);
      if (s.empty) { push(s.layer, e < 0.5 ? k.a : k.b); continue; }
      push(s.layer, e < 0.5 ? render(k.a, m) : render(k.b, compose(m, invert(whole.get(s.layer)!))));
    }
  }
  return out;
}
