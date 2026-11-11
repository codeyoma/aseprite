// FX recipes (#72): an effect described as JSON instead of code. A recipe is a size, an origin, a frame rate, a
// duration, loop or one-shot, a seed, a palette ramp and phases (charge, flash, burst, linger, decay), each a
// time window holding particle emitters, lights, rings, bands and shapes. parseRecipe checks one against the
// schema; compileRecipe turns it into an effect module of pixelfx's shape (meta + create), built from the
// vendored core's particle sim, lights, band and painter, so renderFx and every FX tool take it unchanged.
import * as z from "zod/v4";
import { fit, hex } from "./vendor/core/color.js";
import { Rng } from "./vendor/core/math.js";
import { Lights, P, Particles, band } from "./vendor/core/sim.js";
import type { EffectModule } from "./index.js";
import type { FxAnchor, FxEntry } from "./library.js";
import { Noise, curl2 } from "../sprite_fx/noise.js";
import { OPAQUE, bounds, type Rgba } from "../image.js";

/** The simulation clock (as renderFx): recipes step their sims in exact 1/120 s steps. */
const STEP_HZ = 120;

export const RECIPE_LIMITS = {
  size: 256, count: 400, particles: 1200, duration: 6, phases: 8, items: 16, palette: 16, recipeChars: 16384,
  /** Emitter extras (#107): polyline points, outline points, trail length. */
  pathPoints: 64, outlinePoints: 256, trail: 16,
};

export const PHASES = ["charge", "flash", "burst", "linger", "decay"] as const;
/** The core's particle kinds, by the names a recipe uses (P in vendor/core/sim.js). */
export const PARTICLE_KINDS = {
  spark: P.SPARK, mote: P.MOTE, streak: P.STREAK, flake: P.FLAKE, vapour: P.VAPOUR, dust: P.DUST, star: P.STAR,
  ember: P.EMBER, smoke: P.SMOKE, fire: P.FIRE, brand: P.BRAND, grit: P.GRIT,
} as const;
export const EASES = ["linear", "in", "out", "inout"] as const;

const hexColor = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "a color is '#rrggbb' (or '#rgb')");
/** A palette step (0 = darkest, -1 = brightest, counting from the end when negative) or a hex color. */
const color = z.union([z.number().int("a palette step is a whole number (0 = darkest, -1 = brightest)"), hexColor]);
/** Rings and shapes may also walk down the palette as the phase goes on. */
const animColor = z.union([color, z.literal("cool")]);
const num = (min: number, max: number, what: string) =>
  z.number(`${what} must be a number`).min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`);
/** One value, or [min, max] picked at random per particle. */
const spread = (min: number, max: number, what: string) => z.union([
  num(min, max, what),
  z.tuple([num(min, max, what), num(min, max, what)]).refine(([a, b]) => a <= b, `${what}: [min, max] needs min <= max`),
]);
/** One value, or [from, to] over the phase. */
const anim = (min: number, max: number, what: string) => z.union([num(min, max, what), z.tuple([num(min, max, what), num(min, max, what)])]);
const offset = (what: string) => num(-512, 512, what).optional();

const point = z.tuple([num(-512, 512, "a point's x"), num(-512, 512, "a point's y")], { error: "a point is [x, y]" });
const SHAPE_TYPES = ["line", "ring", "rect", "path", "outline"] as const;
/**
 * Where an emitter spawns (#107), relative to its x, y: along a line, on a ring or arc, in or on a rectangle,
 * along a polyline by arc length, or on a layer's outline pixels (the tool reads the layer and fills `points`).
 * `even` spaces the particles evenly along the shape instead of at random.
 */
const emitShape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("line"), from: point, to: point, even: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("ring"), radius: num(0, 256, "radius"), arc: z.tuple([num(-720, 720, "arc"), num(-720, 720, "arc")]).optional(), even: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("rect"), w: num(0, 512, "w"), h: num(0, 512, "h"), edge: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("path"), points: z.array(point).min(2, "a path needs at least 2 points").max(RECIPE_LIMITS.pathPoints, `a path has at most ${RECIPE_LIMITS.pathPoints} points`), even: z.boolean().optional() }).strict(),
  z.object({
    type: z.literal("outline"), layer: z.string().min(1).optional(), frame: z.number().int().min(1).optional(),
    at: z.enum(["center", "bottom"], "at must be 'center' or 'bottom'").optional(),
    points: z.array(point).min(1, "outline points are [[x, y], ...]").max(RECIPE_LIMITS.outlinePoints, `at most ${RECIPE_LIMITS.outlinePoints} outline points`).optional(),
    even: z.boolean().optional(),
  }).strict(),
], { error: `shape type must be one of ${SHAPE_TYPES.join(", ")}` });

const curlSchema = z.object({
  strength: num(0, 2000, "curl strength"),
  scale: num(2, 256, "curl scale").optional(),
  evolve: num(0, 10, "curl evolve").optional(),
  mode: z.enum(["force", "flow"], "curl mode must be 'force' or 'flow'").optional(),
}).strict();

const emitter = z.object({
  kind: z.enum(Object.keys(PARTICLE_KINDS) as [keyof typeof PARTICLE_KINDS], `kind must be one of ${Object.keys(PARTICLE_KINDS).join(", ")}`),
  count: z.number().int("count is a whole number").min(1, "count must be at least 1").max(RECIPE_LIMITS.count, `count must be at most ${RECIPE_LIMITS.count}`),
  x: offset("x"), y: offset("y"),
  radius: num(0, 128, "radius").optional(),
  speed: spread(0, 2000, "speed"),
  angle: num(-720, 720, "angle").optional(),
  spread: num(0, 360, "spread").optional(),
  life: spread(0.02, 6, "life"),
  delay: num(0, 6, "delay").optional(),
  over: num(0, 6, "over").optional(),
  size: spread(0.3, 12, "size").optional(),
  color: color.optional(),
  gravity: num(-3000, 3000, "gravity").optional(),
  drag: num(0, 30, "drag").optional(),
  shape: emitShape.optional(),
  aim: z.enum(["angle", "out"], "aim must be 'angle' or 'out'").optional(),
  trail: z.number().int("trail is a whole number of positions").min(2, "trail must be at least 2").max(RECIPE_LIMITS.trail, `trail must be at most ${RECIPE_LIMITS.trail}`).optional(),
  curl: curlSchema.optional(),
}).strict().superRefine((e, ctx) => {
  if (e.shape?.type === "outline" && !e.shape.layer && !e.shape.points) {
    ctx.addIssue({ code: "custom", path: ["shape"], message: "an outline shape needs a layer (or points)" });
  }
});

const light = z.object({
  x: offset("x"), y: offset("y"),
  radius: num(1, 256, "radius"),
  strength: num(0, 3, "strength").optional(),
  color: color.optional(),
  delay: num(0, 6, "delay").optional(),
  life: num(0.01, 6, "life").optional(),
}).strict();

const ring = z.object({
  x: offset("x"), y: offset("y"),
  radius: anim(0, 256, "radius"),
  width: anim(0, 64, "width").optional(),
  color: animColor.optional(),
  alpha: anim(0, 1, "alpha").optional(),
  glow: num(0, 2, "glow").optional(),
  ease: z.enum(EASES, `ease must be one of ${EASES.join(", ")}`).optional(),
}).strict();

const bandItem = z.object({
  x: offset("x"), y: offset("y"),
  radius: anim(0, 256, "radius"),
  tilt: num(0.05, 1, "tilt").optional(),
  thickness: num(0.5, 32, "thickness").optional(),
  alpha: anim(0, 1, "alpha").optional(),
  hot: z.boolean().optional(),
  ease: z.enum(EASES, `ease must be one of ${EASES.join(", ")}`).optional(),
}).strict();

const shape = z.object({
  type: z.enum(["disc", "glow"], "shape type must be 'disc' or 'glow'"),
  x: offset("x"), y: offset("y"),
  radius: anim(0, 256, "radius"),
  color: animColor.optional(),
  alpha: anim(0, 1, "alpha").optional(),
  ease: z.enum(EASES, `ease must be one of ${EASES.join(", ")}`).optional(),
}).strict();

const items = <T extends z.ZodType>(s: T, what: string) =>
  z.array(s).max(RECIPE_LIMITS.items, `at most ${RECIPE_LIMITS.items} ${what} a phase`).optional();

const phase = z.object({
  name: z.enum(PHASES, `phase name must be one of ${PHASES.join(", ")}`),
  start: num(0, RECIPE_LIMITS.duration, "start"),
  end: num(0, RECIPE_LIMITS.duration, "end"),
  emitters: items(emitter, "emitters"),
  lights: items(light, "lights"),
  rings: items(ring, "rings"),
  bands: items(bandItem, "bands"),
  shapes: items(shape, "shapes"),
}).strict().refine((p) => p.end > p.start, { message: "end must be after start", path: ["end"] });

const whole = (min: number, max: number, what: string) =>
  z.number().int(`${what} must be whole pixels`).min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`);

export const recipeSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "name is 1-40 lowercase letters, digits and dashes, e.g. 'blue-burst'"),
  description: z.string().max(200, "description is at most 200 characters").optional(),
  size: z.tuple([whole(8, RECIPE_LIMITS.size, "size"), whole(8, RECIPE_LIMITS.size, "size")]),
  origin: z.tuple([whole(0, RECIPE_LIMITS.size, "origin"), whole(0, RECIPE_LIMITS.size, "origin")]),
  fps: num(1, 60, "fps").optional(),
  duration: num(0.05, RECIPE_LIMITS.duration, "duration"),
  loop: z.boolean().optional(),
  seed: z.number().int("seed is a whole number").optional(),
  palette: z.array(hexColor).min(4, "palette needs at least 4 colors, dark to bright").max(RECIPE_LIMITS.palette, `palette has at most ${RECIPE_LIMITS.palette} colors`),
  floor: num(-256, 256, "floor").optional(),
  anchor: z.enum(["center", "ground"], "anchor must be 'center' or 'ground'").optional(),
  phases: z.array(phase).min(1, "a recipe needs at least one phase").max(RECIPE_LIMITS.phases, `at most ${RECIPE_LIMITS.phases} phases`),
}).strict().superRefine((r, ctx) => {
  if (r.origin[0] > r.size[0] || r.origin[1] > r.size[1]) ctx.addIssue({ code: "custom", path: ["origin"], message: `origin must be inside size (${r.size[0]}x${r.size[1]})` });
  r.phases.forEach((p, i) => {
    if (p.end > r.duration + 1e-9) ctx.addIssue({ code: "custom", path: ["phases", i, "end"], message: `end ${p.end} is past the duration (${r.duration} s)` });
    if (!(p.emitters?.length || p.lights?.length || p.rings?.length || p.bands?.length || p.shapes?.length)) {
      ctx.addIssue({ code: "custom", path: ["phases", i], message: "a phase needs something to draw: emitters, lights, rings, bands or shapes" });
    }
  });
  const total = r.phases.reduce((n, p) => n + (p.emitters ?? []).reduce((m, e) => m + e.count, 0), 0);
  if (total > RECIPE_LIMITS.particles) ctx.addIssue({ code: "custom", path: ["phases"], message: `${total} particles in all; at most ${RECIPE_LIMITS.particles}` });
});

export type Recipe = z.infer<typeof recipeSchema>;
type Phase = Recipe["phases"][number];
type Emitter = NonNullable<Phase["emitters"]>[number];
type Ease = (typeof EASES)[number];
type Curl = z.infer<typeof curlSchema>;
type EmitShape = z.infer<typeof emitShape>;

/** Sim steps between trail samples (120 Hz / 4 = 30 per second). */
const TRAIL_STEPS = 4;

/** Bresenham's line from (x0, y0) to (x1, y1), skipping the first point when `skipFirst` (the particle draws it). */
function bresenham(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void, skipFirst = false) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0, first = true;
  for (;;) {
    if (!(first && skipFirst)) plot(x, y);
    first = false;
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * A spawn point on an emission shape (relative to the emitter's x, y) and the shape's outward direction there
 * (aim 'out'): the ring's radius, the rectangle's face or the direction from its centre, a line's or path's left
 * normal, the direction from the outline's centre. Random shapes draw one number (rect two); even ones draw none
 * except rect.
 */
export function shapePoint(s: EmitShape, R: Rng, i: number, count: number): { x: number; y: number; nx: number; ny: number } {
  const even = "even" in s && !!s.even, u = even ? (count === 1 ? 0.5 : i / (count - 1)) : R.next();
  const along = (pts: [number, number][], uu: number) => {
    const lens = pts.slice(1).map((p, k) => Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]));
    const total = lens.reduce((a, b) => a + b, 0);
    let d = uu * total, k = 0;
    while (k < lens.length - 1 && d > lens[k]) { d -= lens[k]; k++; }
    const a = pts[k], b = pts[k + 1], f = lens[k] ? d / lens[k] : 0, tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
    return { x: a[0] + tx * f, y: a[1] + ty * f, nx: ty / tl, ny: -tx / tl };
  };
  switch (s.type) {
    case "line": return along([s.from, s.to], u);
    case "path": return along(s.points, u);
    case "ring": {
      const [a0, a1] = s.arc ?? [0, 360];
      // A full circle spaced evenly does not put two particles on the seam.
      const full = Math.abs(a1 - a0) % 360 === 0;
      const f = even && full && count > 1 ? i / count : u;
      const a = ((a0 + (a1 - a0) * f) * Math.PI) / 180;
      return { x: Math.cos(a) * s.radius, y: Math.sin(a) * s.radius, nx: Math.cos(a), ny: Math.sin(a) };
    }
    case "rect": {
      const v = R.next();
      if (!s.edge) {
        const x = (u - 0.5) * s.w, y = (v - 0.5) * s.h, l = Math.hypot(x, y);
        return { x, y, nx: l ? x / l : 0, ny: l ? y / l : -1 };
      }
      // On the edge, by perimeter length, clockwise from the top-left corner.
      let d = u * 2 * (s.w + s.h);
      const hw = s.w / 2, hh = s.h / 2;
      if (d < s.w) return { x: -hw + d, y: -hh, nx: 0, ny: -1 };
      d -= s.w;
      if (d < s.h) return { x: hw, y: -hh + d, nx: 1, ny: 0 };
      d -= s.h;
      if (d < s.w) return { x: hw - d, y: hh, nx: 0, ny: 1 };
      d -= s.w;
      return { x: -hw, y: hh - d, nx: -1, ny: 0 };
    }
    case "outline": {
      const pts = (s.points ?? [[0, 0]]) as [number, number][];
      const k = even ? Math.round(u * (pts.length - 1)) : Math.min(pts.length - 1, Math.floor(u * pts.length));
      const p = pts[k];
      let cx = 0, cy = 0;
      for (const q of pts) { cx += q[0] + 0.5; cy += q[1] + 0.5; }
      cx /= pts.length; cy /= pts.length;
      const x = p[0] + 0.5, y = p[1] + 0.5, l = Math.hypot(x - cx, y - cy);
      return { x, y, nx: l ? (x - cx) / l : 0, ny: l ? (y - cy) / l : -1 };
    }
  }
}

/**
 * A layer's outline pixels (opaque, with a transparent 4-neighbour or the canvas edge) as points relative to the
 * content's centre or bottom centre, evenly thinned to at most `max`: what an 'outline' emission shape spawns on.
 */
export function outlinePoints(img: Rgba, at: "center" | "bottom" = "center", max = RECIPE_LIMITS.outlinePoints): [number, number][] {
  const b = bounds(img);
  if (!b) return [];
  const { width: w, height: h, data } = img;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= OPAQUE;
  const ox = Math.floor(b.x + b.w / 2), oy = at === "bottom" ? b.y + b.h : Math.floor(b.y + b.h / 2);
  const all: [number, number][] = [];
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    if (on(x, y) && (!on(x + 1, y) || !on(x - 1, y) || !on(x, y + 1) || !on(x, y - 1))) all.push([x - ox, y - oy]);
  }
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, k) => all[Math.floor((k * all.length) / max)]);
}


/** "phases.0.emitters.1.count: count must be at most 400" lines. */
function formatIssues(err: z.ZodError): string {
  return err.issues.slice(0, 12).map((i) => {
    const path = i.path.map(String).join(".");
    return `- ${path || "recipe"}: ${i.message}`;
  }).join("\n") + (err.issues.length > 12 ? `\n- … ${err.issues.length - 12} more` : "");
}

/** A recipe from JSON text or an object; throws an Error listing every problem by path. */
export function parseRecipe(input: unknown): Recipe {
  let value = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch (e) { throw new Error(`The recipe is not valid JSON: ${(e as Error).message}`); }
  }
  const r = recipeSchema.safeParse(value);
  if (!r.success) throw new Error(`The recipe has problems:\n${formatIssues(r.error)}`);
  return r.data;
}

const EASE: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};
const pick = (R: Rng, v: number | [number, number]) => (typeof v === "number" ? v : R.range(v[0], v[1]));
const hi = (v: number | [number, number]) => (typeof v === "number" ? v : v[1]);
const at = (v: number | [number, number], u: number) => (typeof v === "number" ? v : v[0] + (v[1] - v[0]) * u);

/**
 * When a recipe's last thing is gone (seconds from the start of its cycle): the latest particle death, light and
 * phase end. Loops keep this many cycles' worth of sims running at once, so particles cross the seam.
 */
export function recipeSpan(r: Recipe): number {
  let span = 0;
  for (const p of r.phases) {
    span = Math.max(span, p.end);
    for (const e of p.emitters ?? []) span = Math.max(span, p.start + (e.delay ?? 0) + (e.over ?? 0) + hi(e.life));
    for (const l of p.lights ?? []) span = Math.max(span, p.start + (l.delay ?? 0) + (l.life ?? p.end - p.start));
  }
  return span;
}

/**
 * Compile a recipe into an effect module (pixelfx's shape: meta and create). Coordinates are px from the origin
 * (y down), angles degrees (0 right, -90 up), times seconds. Each cycle of the effect is one "run": a particle
 * system and lights spawned at its start, stepped in exact 1/120 s steps, plus rings, bands and shapes drawn
 * from its own time. A one-shot is one run. A loop keeps enough runs going, one starting every duration, for
 * particles to outlive their cycle; all runs are the same (same seed, same steps), so the frame at t is the sum
 * of the run at t mod duration and the older ones, and the effect wraps exactly.
 */
export function compileRecipe(recipe: Recipe): EffectModule {
  const D = recipe.duration, loop = !!recipe.loop;
  const meta = {
    name: recipe.name, desc: recipe.description ?? `Recipe ${recipe.name}`, tags: ["recipe", loop ? "loop" : "one-shot"],
    size: [recipe.size[0], recipe.size[1]] as [number, number], origin: [recipe.origin[0], recipe.origin[1]] as [number, number],
    duration: D, loop, fps: recipe.fps ?? 30, bg: "dark",
    options: { palette: [...recipe.palette], seed: recipe.seed ?? 1 },
  };
  const cycleSteps = Math.max(1, Math.round(D * STEP_HZ));
  const runs = loop ? Math.ceil((recipeSpan(recipe) * STEP_HZ + 1) / cycleSteps) : 1;

  function create(o: Record<string, unknown>) {
    const n = recipe.palette.length;
    const C: number[] = fit(o.palette as string[], n);
    const step = (i: number) => C[Math.max(0, Math.min(n - 1, i < 0 ? n + i : i))];
    const colorOf = (c: number | string | undefined, fallback: number): number => (c === undefined ? fallback : typeof c === "number" ? step(c) : hex(c));
    const seed = Number(o.seed ?? 1);
    const floor = recipe.floor;

    interface Run { step: number; ps: Particles; lights: Lights; pending: { at: number; add: () => void }[] }
    const newRun = (): Run => {
      const R = new Rng(seed);
      const ps = new Particles({ rng: R, ground: floor === undefined ? undefined : () => floor, sparks: [step(-1), step(-2), step(-3), step(Math.max(0, n - 5))] });
      const lights = new Lights();
      const pending: Run["pending"] = [];
      for (const p of recipe.phases) {
        for (const e of p.emitters ?? []) spawn(ps, R, e, p.start);
        for (const l of p.lights ?? []) {
          const life = l.life ?? p.end - p.start;
          pending.push({ at: Math.round((p.start + (l.delay ?? 0)) * STEP_HZ),
            add: () => lights.add(l.x ?? 0, l.y ?? 0, l.radius, colorOf(l.color, step(-2)), l.strength ?? 0.5, life) });
        }
      }
      return { step: 0, ps, lights, pending };
    };
    const spawn = (ps: Particles, R: Rng, e: Emitter, start: number) => {
      const kind = PARTICLE_KINDS[e.kind];
      const own = kind === P.FIRE || kind === P.SMOKE;
      const col = e.color === undefined ? (own ? 0 : step(-2)) : colorOf(e.color, 0);
      const out = e.aim === "out" && !!e.shape;
      const angle = ((e.angle ?? -90) * Math.PI) / 180, half = (((e.spread ?? (out ? 30 : 360)) / 2) * Math.PI) / 180;
      // A trail walks down the ramp from the particle's own step (the brightest for hex colors).
      const head = typeof e.color === "number" ? Math.max(0, Math.min(n - 1, e.color < 0 ? n + e.color : e.color)) : n - 1;
      for (let i = 0; i < e.count; i++) {
        let a = angle + R.range(-half, half);
        const v = pick(R, e.speed);
        let x: number, y: number;
        if (e.shape) {
          // A shape replaces the spawn disc; aim 'out' turns the angle to the shape's outward direction there.
          const s = shapePoint(e.shape, R, i, e.count);
          x = (e.x ?? 0) + s.x; y = (e.y ?? 0) + s.y;
          if (out) a += Math.atan2(s.ny, s.nx) - angle;
        } else {
          const ra = R.range(0, Math.PI * 2), rr = (e.radius ?? 0) * Math.sqrt(R.next());
          x = (e.x ?? 0) + Math.cos(ra) * rr; y = (e.y ?? 0) + Math.sin(ra) * rr;
        }
        const delay = start + (e.delay ?? 0) + (e.over ? R.range(0, e.over) : 0);
        ps.spawn(kind, x, y, Math.cos(a) * v, Math.sin(a) * v, pick(R, e.life), col, pick(R, e.size ?? 1), delay);
        const q = ps.list[ps.list.length - 1];
        if (e.gravity || e.drag) Object.assign(q, { xg: e.gravity ?? 0, xd: e.drag ?? 0 });
        if (e.trail) Object.assign(q, { tr: [] as [number, number][], tk: e.trail, th: head });
        if (e.curl) Object.assign(q, { cu: e.curl });
      }
    };
    const dt = 1 / STEP_HZ;
    const curlNoise = new Noise(seed + 101);
    const stepRun = (run: Run) => {
      for (const p of run.pending) if (p.at === run.step) p.add();
      // Curl-noise motion (Bridson et al. 2007): the curl of a noise potential, divergence-free, at the run's own
      // time (so every run of a loop moves the same way). 'force' accelerates the particle, 'flow' carries it.
      const time = run.step / STEP_HZ;
      for (const q of run.ps.list as Array<{ delay: number; x: number; y: number; vx: number; vy: number; cu?: Curl }>) {
        if (!q.cu || q.delay > 0) continue;
        const sc = q.cu.scale ?? 24, [cx, cy] = curl2(curlNoise, "simplex", q.x / sc, q.y / sc, time * (q.cu.evolve ?? 0.5));
        // The mean |curl| of simplex noise is about 2; halved so strength is about px/s (flow) or px/s² (force).
        const k = q.cu.strength * 0.5 * dt;
        if (q.cu.mode === "flow") { q.x += cx * k; q.y += cy * k; } else { q.vx += cx * k; q.vy += cy * k; }
      }
      // The recipe's own gravity and drag, on top of what the kind does.
      for (const q of run.ps.list as Array<{ delay: number; vx: number; vy: number; xg?: number; xd?: number }>) {
        if (q.xg === undefined || q.delay > 0) continue;
        q.vy += q.xg * dt;
        q.vx -= q.vx * (q.xd ?? 0) * dt;
        q.vy -= q.vy * (q.xd ?? 0) * dt;
      }
      run.ps.update(dt);
      run.lights.update(dt);
      run.step++;
      // Trails: the particle's whole-pixel position every 1/30 s, the last k kept.
      if (run.step % TRAIL_STEPS === 0) {
        for (const q of run.ps.list as Array<{ delay: number; x: number; y: number; tr?: [number, number][]; tk?: number }>) {
          if (!q.tr || q.delay > 0) continue;
          const px = Math.floor(q.x), py = Math.floor(q.y), last = q.tr[q.tr.length - 1];
          if (!last || last[0] !== px || last[1] !== py) q.tr.push([px, py]);
          if (q.tr.length > q.tk!) q.tr.shift();
        }
      }
    };
    /** A run's trails: Bresenham lines from the head back through its last positions, down the ramp. */
    const drawTrails = (p: any, run: Run) => {
      for (const q of run.ps.list as Array<{ delay: number; x: number; y: number; tr?: [number, number][]; th?: number }>) {
        if (!q.tr?.length || q.delay > 0) continue;
        const pts: [number, number][] = [[Math.floor(q.x), Math.floor(q.y)], ...q.tr.slice().reverse()];
        const segs = pts.length - 1;
        for (let j = 0; j < segs; j++) {
          const c = step(Math.round(q.th! * (1 - (j + 1) / (segs + 1))));
          bresenham(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1], (x, y) => p.px(x, y, c), j === 0);
        }
      }
    };

    // Newest run first. A loop's run k is k cycles older than the newest, so it starts k * cycleSteps in.
    const live: Run[] = [];
    for (let k = 0; k < runs; k++) {
      const run = newRun();
      for (let s = 0; s < k * cycleSteps; s++) stepRun(run);
      live.push(run);
    }
    let acc = 0;

    /** Rings, bands and shapes of one run at its own time (seconds), in phase windows [start, end). */
    const drawShapes = (p: any, t: number, what: "shapes" | "front") => {
      for (const ph of recipe.phases) {
        if (t < ph.start || t >= ph.end) continue;
        const u0 = (t - ph.start) / (ph.end - ph.start);
        const cool = (u: number) => step(Math.min(n - 1, Math.round((1 - u) * (n - 1))));
        if (what === "shapes") {
          for (const s of ph.shapes ?? []) {
            const u = EASE[s.ease ?? "out"](u0), r = at(s.radius, u), a = at(s.alpha ?? 1, u);
            const c = s.color === "cool" ? cool(u) : colorOf(s.color, step(-2));
            if (s.type === "disc") p.disc(s.x ?? 0, s.y ?? 0, r, c, a);
            else p.glow(s.x ?? 0, s.y ?? 0, r, c, a);
          }
          continue;
        }
        for (const b of ph.bands ?? []) {
          const u = EASE[b.ease ?? "out"](u0);
          band(p, b.x ?? 0, b.y ?? 0, at(b.radius, u), b.tilt ?? 0.3, b.thickness ?? 2, at(b.alpha ?? [1, 0], u), C, undefined, !!b.hot);
        }
        for (const g of ph.rings ?? []) {
          const u = EASE[g.ease ?? "out"](u0), r = at(g.radius, u), w = at(g.width ?? 1, u), a = at(g.alpha ?? [1, 0], u);
          const c = g.color === "cool" ? cool(u) : colorOf(g.color, step(-1));
          if (r <= 0 || a <= 0) continue;
          p.ring(g.x ?? 0, g.y ?? 0, r, w, c, a);
          if (g.glow) p.glowRing(g.x ?? 0, g.y ?? 0, r - w / 2, Math.max(2, w * 2), c, g.glow * a);
        }
      }
    };

    return {
      update(dtIn: number) {
        acc += dtIn;
        while (acc >= dt - 1e-7) {
          acc -= dt;
          for (const run of live) stepRun(run);
          // A loop starts a new run every cycle and drops the oldest (it has drawn its last by then).
          if (loop && live[0].step === cycleSteps) {
            live.pop();
            live.unshift(newRun());
          }
        }
      },
      drawBack(p: any) {
        for (let k = live.length - 1; k >= 0; k--) {
          drawShapes(p, live[k].step / STEP_HZ, "shapes");
          live[k].ps.draw(p, "back");
        }
      },
      draw(p: any) {
        for (let k = live.length - 1; k >= 0; k--) {
          drawShapes(p, live[k].step / STEP_HZ, "front");
          drawTrails(p, live[k]);
          live[k].ps.draw(p, "front");
          live[k].lights.draw(p);
        }
      },
    };
  }

  return { meta, create } as unknown as EffectModule;
}

/** A recipe as an FX library entry (id 'recipe:<name>'), so the placing tools treat it like a library effect. */
export function recipeEntry(recipe: Recipe): FxEntry {
  const module = compileRecipe(recipe);
  const anchor: FxAnchor = recipe.anchor ?? "center";
  return {
    id: `recipe:${recipe.name}`, title: recipe.name, description: recipe.description ?? "", category: "recipe",
    tags: ["recipe"], loop: !!recipe.loop, durationMs: Math.round(recipe.duration * 1000),
    size: { width: recipe.size[0], height: recipe.size[1] }, origin: { x: recipe.origin[0], y: recipe.origin[1] },
    anchor, fps: recipe.fps ?? 30, palette: [...recipe.palette], seed: recipe.seed ?? 1, options: [], module,
  };
}
