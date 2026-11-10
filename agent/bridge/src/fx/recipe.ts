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

/** The simulation clock (as renderFx): recipes step their sims in exact 1/120 s steps. */
const STEP_HZ = 120;

export const RECIPE_LIMITS = {
  size: 256, count: 400, particles: 1200, duration: 6, phases: 8, items: 16, palette: 16, recipeChars: 16384,
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
}).strict();

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
      const angle = ((e.angle ?? -90) * Math.PI) / 180, half = (((e.spread ?? 360) / 2) * Math.PI) / 180;
      for (let i = 0; i < e.count; i++) {
        const a = angle + R.range(-half, half), v = pick(R, e.speed);
        const ra = R.range(0, Math.PI * 2), rr = (e.radius ?? 0) * Math.sqrt(R.next());
        const delay = start + (e.delay ?? 0) + (e.over ? R.range(0, e.over) : 0);
        ps.spawn(kind, (e.x ?? 0) + Math.cos(ra) * rr, (e.y ?? 0) + Math.sin(ra) * rr, Math.cos(a) * v, Math.sin(a) * v,
          pick(R, e.life), col, pick(R, e.size ?? 1), delay);
        if (e.gravity || e.drag) Object.assign(ps.list[ps.list.length - 1], { xg: e.gravity ?? 0, xd: e.drag ?? 0 });
      }
    };
    const dt = 1 / STEP_HZ;
    const stepRun = (run: Run) => {
      for (const p of run.pending) if (p.at === run.step) p.add();
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
