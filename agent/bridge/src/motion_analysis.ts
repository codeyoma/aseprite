// Motion analysis (#111): whether an animation moves well, measured. One pass over a tag builds a track per part
// (its layer, or the whole figure): area, bounds, centroid, top and feet in every frame. From the tracks come the
// metrics the checks, the motion gate and the benchmarks share: spacing (eased or even, pops), arcs (a limb that only
// slides on a straight line), volume (a part that grows or shrinks), flicker (pixels that blink A->B->A), the ground
// line (jitter of the lowest row), foot slide (a planted foot sliding forward), the loop seam and flat timing.
//
// The pure part (analyzeTracks, flickerOf, ...) works on images; trackClip reads them through the Document module.
import type { Document } from "./document.js";
import type { Rgba } from "./image.js";
import type { ClipView } from "./motion_clip.js";

const OPAQUE = 128;

/** A part's silhouette in one frame (alpha >= 128); undefined fields when the part is empty there. */
export interface PartFrame {
  frame: number;
  area: number;
  bounds?: [number, number, number, number];
  centroid?: [number, number];
  /** Middle x of the top row and of the bottom row, with their rows. */
  top?: [number, number];
  feet?: [number, number];
}

export interface PartTrack {
  /** The layer name, or "" for the whole figure. */
  part: string;
  frames: PartFrame[];
}

/** The silhouette measures of one image. */
export function silhouette(img: Rgba, frame: number): PartFrame {
  let area = 0, sx = 0, sy = 0, x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < OPAQUE) continue;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!area) return { frame, area: 0 };
  const rowMid = (y: number): [number, number] => {
    let s = 0, n = 0;
    for (let x = x0; x <= x1; x++) if (img.data[(y * img.width + x) * 4 + 3] >= OPAQUE) { s += x; n++; }
    return [s / n, y];
  };
  const r = (v: number) => Math.round(v * 100) / 100;
  return { frame, area, bounds: [x0, y0, x1, y1], centroid: [r(sx / area), r(sy / area)], top: rowMid(y0), feet: rowMid(y1) };
}

export type Severity = "error" | "warning" | "info";

export interface MotionFinding {
  metric: "spacing" | "arc" | "volume" | "flicker" | "ground" | "foot-slide" | "seam" | "timing" | "static";
  severity: Severity;
  part: string;
  frames: number[];
  message: string;
}

export interface MotionMetrics {
  /** Per part: centroid step per frame (px), the share of steps within 0.5 px of the mean (1 = even spacing). */
  spacing: { part: string; steps: number[]; evenness: number }[];
  /** Per part that travels: the largest distance (px) of its centroid path from the straight line between its ends. */
  arcs: { part: string; travel: number; bend: number }[];
  /** Per part: largest area change against the part's median area, as a share (0.25 = 25%). */
  volume: { part: string; drift: number }[];
  /** Pixels that blink A->B->A, per middle frame (whole figure). */
  flicker: { frame: number; pixels: number }[];
  /** Lowest row of the figure per frame. */
  ground: number[];
  /** Distinct frame durations of the tag. */
  durations: number[];
}

export interface MotionReport {
  tracks: PartTrack[];
  metrics: MotionMetrics;
  findings: MotionFinding[];
}

/** Thresholds (#111). Volume and flicker are errors: a viewer reads them as broken drawing, not as style. */
export const LIMITS = {
  /** A part's area may change this much against its median before it reads as growing or shrinking. */
  volume: 0.25,
  /** A step this many times the median step (and over 2 px) pops. */
  pop: 2.5,
  /** Boiling pixels per frame as a share of the figure's area. */
  flicker: 0.015,
  /** A part that travels at least this far should bend off the straight line by this much over 3+ frames. */
  arcTravel: 4,
  arcBend: 0.75,
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** The most pixels a cluster of changed pixels may have to count as boiling: bigger clusters are a part moving. */
export const BOIL_CLUSTER = 2;

/**
 * Boiling pixels per frame: opaque in a frame and both its neighbors, the neighbors the same color and the frame a
 * different one (A->B->A inside the shape), in clusters of at most BOIL_CLUSTER pixels (8-connected). Larger
 * clusters are a part passing over another (an arm swinging across the body), and pixels that come and go with the
 * silhouette are motion too, so both are left out.
 */
export function flickerOf(images: Rgba[], frames: number[], loop: boolean): { frame: number; pixels: number }[] {
  const out: { frame: number; pixels: number }[] = [];
  const n = images.length;
  for (let i = 0; i < n; i++) {
    if (!loop && (i === 0 || i === n - 1)) continue;
    if (n < 3) break;
    const a = images[(i - 1 + n) % n], b = images[i], c = images[(i + 1) % n];
    const w = b.width, h = b.height;
    const key = (img: Rgba, p: number) => (img.data[p + 3] < OPAQUE ? -1 : (img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2]);
    const hit = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const ka = key(a, k * 4), kb = key(b, k * 4), kc = key(c, k * 4);
      if (ka >= 0 && kb >= 0 && ka === kc && kb !== ka) hit[k] = 1;
    }
    let count = 0;
    const seen = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      if (!hit[k] || seen[k]) continue;
      const stack = [k], comp: number[] = [];
      seen[k] = 1;
      while (stack.length) {
        const q = stack.pop()!;
        comp.push(q);
        const x = q % w, y = (q - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const m = ny * w + nx;
          if (hit[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
        }
      }
      if (comp.length <= BOIL_CLUSTER) count += comp.length;
    }
    out.push({ frame: frames[i], pixels: count });
  }
  return out;
}

/**
 * The metrics and findings of a tag from its tracks (the whole figure first, then parts), the whole figure's images
 * (for flicker) and its durations.
 */
export function analyzeTracks(tracks: PartTrack[], images: Rgba[], o: {
  frames: number[]; durations: number[]; loop: boolean; facing?: "right" | "left"; contacts?: number[]; keys?: number[];
}): MotionReport {
  const findings: MotionFinding[] = [];
  const metrics: MotionMetrics = { spacing: [], arcs: [], volume: [], flicker: [], ground: [], durations: [...new Set(o.durations)].sort((a, b) => a - b) };
  const name = (p: string) => (p ? `"${p}"` : "the figure");

  for (const t of tracks) {
    const drawn = t.frames.filter((f) => f.area > 0);
    if (drawn.length < 2) continue;
    // Volume: area against the median.
    const med = median(drawn.map((f) => f.area));
    let worst = 0, worstFrames: number[] = [];
    for (const f of drawn) {
      const d = Math.abs(f.area - med) / med;
      if (d > worst + 1e-9) { worst = d; worstFrames = [f.frame]; } else if (Math.abs(d - worst) < 1e-9) worstFrames.push(f.frame);
    }
    metrics.volume.push({ part: t.part, drift: round(worst) });
    if (worst > LIMITS.volume && med >= 8) {
      findings.push({ metric: "volume", severity: t.part ? "error" : "warning", part: t.part, frames: worstFrames,
        message: `${name(t.part)} is ${Math.round(worst * 100)}% ${drawn.find((f) => f.frame === worstFrames[0])!.area > med ? "bigger" : "smaller"} in frame ${worstFrames.join(", ")} than in most frames (${med} px): keep its size; redraw it from a key, or move and rotate it instead of redrawing.` });
    }
    // Spacing: centroid steps between consecutive frames (and the seam for a loop).
    const pts = t.frames.map((f) => f.centroid);
    const steps: number[] = [];
    const stepFrames: number[] = [];
    for (let i = 1; i < pts.length; i++) if (pts[i] && pts[i - 1]) { steps.push(round(dist(pts[i]!, pts[i - 1]!), 1)); stepFrames.push(t.frames[i].frame); }
    const moving = steps.filter((s) => s >= 0.5);
    if (steps.length >= 2) {
      const mean = steps.reduce((s, x) => s + x, 0) / steps.length;
      const evenness = round(steps.filter((s) => Math.abs(s - mean) <= 0.5).length / steps.length);
      metrics.spacing.push({ part: t.part, steps, evenness });
      const m = median(moving.length ? moving : steps);
      const pops = steps.map((s, i) => (s > 2 && m > 0 && s > LIMITS.pop * m ? stepFrames[i] : 0)).filter(Boolean);
      if (pops.length && moving.length >= 2) {
        findings.push({ metric: "spacing", severity: "warning", part: t.part, frames: pops,
          message: `${name(t.part)} jumps into frame ${pops.join(", ")} (${pops.map((f) => steps[stepFrames.indexOf(f)]).join(", ")} px against ${round(m, 1)} px a frame): add an in-between or spread the move (rule:anim.spacing).` });
      }
      if (t.part && moving.length >= 3 && evenness === 1 && mean >= 1) {
        findings.push({ metric: "spacing", severity: "info", part: t.part, frames: stepFrames,
          message: `${name(t.part)} moves the same ${round(mean, 1)} px every frame: even spacing reads mechanical; ease in and out of the keys (rule:anim.spacing).` });
      }
      if (o.loop && pts[0] && pts[pts.length - 1]) {
        const seam = dist(pts[0]!, pts[pts.length - 1]!);
        if (seam > 2 && m > 0 && seam > LIMITS.pop * m) {
          findings.push({ metric: "seam", severity: "warning", part: t.part, frames: [t.frames[t.frames.length - 1].frame, t.frames[0].frame],
            message: `${name(t.part)} jumps ${round(seam, 1)} px from the last frame back to the first (${round(m, 1)} px a frame elsewhere): the loop pops; make the last frame lead into the first.` });
        }
      }
    }
    // Arcs: a part (not the whole figure) that travels but stays on a straight line.
    const path = pts.filter(Boolean) as [number, number][];
    if (t.part && path.length >= 3) {
      let travel = 0, bend = 0, from = 0, to = 0;
      for (let i = 0; i < path.length; i++) for (let j = i + 2; j < path.length; j++) {
        const d = dist(path[i], path[j]);
        if (d > travel) { travel = d; from = i; to = j; }
      }
      if (travel > 0) {
        const [a, b] = [path[from], path[to]];
        for (let k = from + 1; k < to; k++) {
          const p = path[k];
          const off = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / travel;
          if (off > bend) bend = off;
        }
      }
      metrics.arcs.push({ part: t.part, travel: round(travel, 1), bend: round(bend, 1) });
      if (travel >= LIMITS.arcTravel && to - from >= 2 && bend < LIMITS.arcBend) {
        findings.push({ metric: "arc", severity: "info", part: t.part, frames: t.frames.slice(from, to + 1).map((f) => f.frame),
          message: `${name(t.part)} travels ${round(travel, 1)} px on a straight line: limbs and swung things move on arcs (rule:anim.arcs); bend the in-betweens off the line.` });
      }
    }
  }

  // The whole figure: flicker, ground line, foot slide.
  const whole = tracks.find((t) => t.part === "");
  if (whole) {
    metrics.flicker = flickerOf(images, o.frames, o.loop);
    const blink = metrics.flicker.filter((f) => {
      const area = whole.frames.find((x) => x.frame === f.frame)?.area ?? 0;
      return area > 0 && f.pixels >= 3 && f.pixels / area > LIMITS.flicker;
    });
    if (blink.length) {
      findings.push({ metric: "flicker", severity: "error", part: "", frames: blink.map((f) => f.frame),
        message: `Pixels boil in frame ${blink.map((f) => `${f.frame} (${f.pixels} px)`).join(", ")}: single pixels inside the shape change color and change back in the next frame, so they shimmer in play. Keep the colors of what doesn't move the same as in the frames beside it.` });
    }
    metrics.ground = whole.frames.map((f) => f.bounds?.[3] ?? -1);
    const rows = metrics.ground.filter((g) => g >= 0);
    const low = Math.max(...rows);
    const off = whole.frames.filter((f) => f.bounds && low - f.bounds[3] >= 1 && low - f.bounds[3] <= 3);
    if (rows.length >= 3 && off.length && off.length <= rows.length / 2 && (o.contacts?.length ?? 0) > 0) {
      findings.push({ metric: "ground", severity: "warning", part: "", frames: off.map((f) => f.frame),
        message: `The feet leave the ground row ${low} in frame ${off.map((f) => `${f.frame} (row ${f.bounds![3]})`).join(", ")}: a walk keeps a foot on the ground every frame.` });
    }
    // Foot slide: from each contact to the next frame, the planted foot (the bottom row's middle) must not move forward.
    if (o.contacts?.length && o.facing) {
      const dir = o.facing === "right" ? 1 : -1;
      const slid: number[] = [];
      for (const c of o.contacts) {
        const i = whole.frames.findIndex((f) => f.frame === c);
        const a = whole.frames[i]?.feet, b = whole.frames[i + 1]?.feet;
        if (a && b && a[1] === b[1] && (b[0] - a[0]) * dir >= 1.5) slid.push(c);
      }
      if (slid.length) {
        findings.push({ metric: "foot-slide", severity: "warning", part: "", frames: slid,
          message: `The planted foot slides forward after contact frame ${slid.join(", ")}: a foot carrying the weight stays put or slides back by the walk's ground speed (rule:anim.timing.walk).` });
      }
    }
    if (!tracks.some((t) => t.frames.filter((f) => f.centroid).length >= 2 && t.frames.some((f, i) => i > 0 && f.centroid && t.frames[i - 1].centroid && dist(f.centroid, t.frames[i - 1].centroid!) >= 0.5))
      && images.length >= 2 && images.every((img, i) => i === 0 || Buffer.compare(Buffer.from(img.data), Buffer.from(images[0].data)) === 0)) {
      findings.push({ metric: "static", severity: "error", part: "", frames: o.frames, message: "Nothing moves: every frame is the same." });
    }
  }

  // Timing: every frame the same length, keys never held.
  if (o.durations.length >= 4 && metrics.durations.length === 1) {
    findings.push({ metric: "timing", severity: "info", part: "", frames: o.frames,
      message: `Every frame lasts ${metrics.durations[0]} ms: hold the keys a little longer and pass through the in-betweens faster (rule:anim.ticks).` });
  }
  return { tracks, metrics, findings };
}

/**
 * Measures a clip: the whole figure plus each of `parts` (layer names; default the clip's rig parts and walk limbs)
 * in every frame of the tag.
 */
export async function trackClip(doc: Document, v: ClipView, parts: string[]): Promise<MotionReport> {
  const images: Rgba[] = [];
  const whole: PartTrack = { part: "", frames: [] };
  for (const f of v.frames) {
    const img = await doc.pixels(undefined, f);
    images.push(img);
    whole.frames.push(silhouette(img, f));
  }
  const tracks = [whole];
  for (const p of parts) {
    const t: PartTrack = { part: p, frames: [] };
    for (const f of v.frames) t.frames.push(silhouette(await doc.pixels(p, f), f));
    tracks.push(t);
  }
  const durations = v.frames.map((f, i) => (i + 1 < v.startMs.length ? v.startMs[i + 1] - v.startMs[i] : v.lengthMs - v.startMs[i]));
  return analyzeTracks(tracks, images, {
    frames: v.frames, durations, loop: v.clip.loop, facing: v.clip.facing, contacts: v.contacts, keys: v.keys,
  });
}

/** The report as text for the agent: findings first (errors, warnings, notes), then the numbers. */
export function describeReport(name: string, r: MotionReport): string {
  const order: Severity[] = ["error", "warning", "info"];
  const sorted = [...r.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const label = (p: string) => (p ? p : "figure");
  const m = r.metrics;
  const errors = r.findings.filter((f) => f.severity === "error").length;
  return [
    `MOTION CHECK "${name}": ${errors ? `${errors} error${errors > 1 ? "s" : ""}` : r.findings.some((f) => f.severity === "warning") ? "warnings" : "ok"}`,
    ...sorted.map((f) => `${f.severity}: [${f.metric}] ${f.message}`),
    `spacing (px a frame): ${m.spacing.map((s) => `${label(s.part)} ${s.steps.join(" ")}`).join("; ") || "none"}`,
    ...(m.arcs.length ? [`arcs: ${m.arcs.map((a) => `${label(a.part)} travels ${a.travel} px, bends ${a.bend} px`).join("; ")}`] : []),
    `volume drift: ${m.volume.map((v) => `${label(v.part)} ${Math.round(v.drift * 100)}%`).join("; ") || "none"}`,
    `flicker (px): ${m.flicker.map((f) => `${f.frame}:${f.pixels}`).join(" ") || "none"}`,
    `ground row: ${m.ground.join(" ") || "none"}; durations: ${m.durations.join(", ")} ms`,
  ].join("\n");
}
