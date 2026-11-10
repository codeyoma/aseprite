// FX recipes and the FX check (#72): fx_from_recipe makes an effect from a JSON recipe (fx/recipe.ts) and
// previews it, adds it like add_fx or makes it a sprite like new_fx_sprite, through the same code; check_fx
// checks effect layers for pixels off the canvas, one-shots that don't end empty, loop seams and too many colors.
import * as z from "zod/v4";
import { documentOf, type Document, type FxInfo, type LayerInfo } from "./document.js";
import { renderFx } from "./fx/index.js";
import { findFx, type FxEntry } from "./fx/library.js";
import { RECIPE_LIMITS, parseRecipe, recipeEntry } from "./fx/recipe.js";
import { anchorInput, effectOptions, fxCanvas, fxSprite, placeFx, previewFx } from "./fx_tools.js";
import { OPAQUE, type Rgba } from "./image.js";
import { failure, text, type Tool, type ToolResult } from "./tool.js";

/** The effect an FX record names, rebuilt to render again: its recipe, else the library effect; undefined when neither. */
export function recordedEffect(fx: FxInfo): { e: FxEntry; opts: Record<string, unknown>; seed: number; flip: boolean; angle: number } | undefined {
  let e: FxEntry | undefined;
  try {
    e = fx.recipe ? recipeEntry(parseRecipe(fx.recipe)) : findFx(fx.id);
  } catch {
    return undefined;
  }
  if (!e) return undefined;
  let render: { seed?: number; flip?: boolean; angle?: number; options?: Record<string, unknown>; palette?: string[]; light?: number } = {};
  try { render = fx.render ? JSON.parse(fx.render) : {}; } catch { /* a broken render record: defaults */ }
  let opts: Record<string, unknown>;
  try { opts = effectOptions(e, render); } catch { opts = {}; }
  return { e, opts, seed: render.seed ?? e.seed, flip: !!render.flip, angle: render.angle ?? 0 };
}

export interface FxFinding {
  rule: "spill" | "one-shot-end" | "loop-seam" | "colors";
  severity: "error" | "warning";
  layer: string;
  layerId: string;
  /** The sprite frame it is about (1-based), when one. */
  frame?: number;
  count: number;
  /** Up to 8 sample pixels, sprite coordinates (outside the sprite for spills). */
  pixels: [number, number][];
  /** What was found, with bounds. */
  message: string;
  fix: string;
}

export interface FxCheckOptions {
  /** Colors (distinct RGB) a layer may use before the colors rule fires. Default 24. */
  maxColors?: number;
}

const SAMPLES = 8;
/** Margin around the effect's canvas when re-rendering, to catch drawing past it (pixelfx's check uses 24). */
const MARGIN = 32;

const diffCount = (a: Rgba, b: Rgba, out?: [number, number][]) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2] && a.data[i + 3] === b.data[i + 3]) continue;
    if (out && out.length < SAMPLES) out.push([(i / 4) % a.width, Math.floor(i / 4 / a.width)]);
    n++;
  }
  return n;
};
const litCount = (img: Rgba) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++;
  return n;
};
const span = (pts: { x0: number; y0: number; x1: number; y1: number }) => `x ${pts.x0}..${pts.x1}, y ${pts.y0}..${pts.y1}`;

/**
 * Checks one effect layer: its images per sprite frame (frame 1 first, sprite size; null for no cel) and its
 * FX record when it has one. Pure, for tests. Rules:
 * - spill: re-rendered from the record at its origin (needs a library id or a recipe), the pixels the effect
 *   draws outside the sprite (error) or past its own canvas, where the placing tools cut it (warning); without a
 *   record to render, pixels on the sprite's border in any frame (warning: probably cut off).
 * - one-shot-end: a one-shot that still draws at t = duration (re-rendered), so it pops off instead of fading
 *   out; without a record to render, a last frame with content that is the sprite's last frame.
 * - loop-seam: in a loop, the change from the layer's last frame back to its first (pixels that differ) is
 *   more than twice a normal step between neighbouring frames (the 90th percentile) and more than 12 px.
 * - colors: more distinct opaque colors (alpha >= OPAQUE; soft glow fringes do not count) on the layer than maxColors.
 */
export function checkFxLayer(layer: LayerInfo, images: (Rgba | null)[], sprite: { width: number; height: number }, o: FxCheckOptions = {}): FxFinding[] {
  const out: FxFinding[] = [];
  const base = { layer: layer.name, layerId: layer.id };
  const fx = layer.fx;
  const rec = fx ? recordedEffect(fx) : undefined;
  const W = sprite.width, H = sprite.height;
  const blank = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  const imgs = images.map((im) => im ?? blank);

  // Spill.
  if (fx && rec) {
    const c = fxCanvas(rec.e, rec.flip, rec.angle);
    const canvas = { width: c.width + 2 * MARGIN, height: c.height + 2 * MARGIN, x: c.x + MARGIN, y: c.y + MARGIN };
    const r = renderFx(rec.e.module, rec.opts, { fps: fx.fps, seed: rec.seed, canvas });
    const dx = fx.x - canvas.x, dy = fx.y - canvas.y;
    let worst = { off: 0, frame: 0, pixels: [] as [number, number][] }, past = 0, pastFrame = 0;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    r.color.forEach((img, i) => {
      let off = 0, outCanvas = 0;
      const pixels: [number, number][] = [];
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        if (!img.data[(y * img.width + x) * 4 + 3]) continue;
        const sx = x + dx, sy = y + dy;
        box.x0 = Math.min(box.x0, sx); box.x1 = Math.max(box.x1, sx); box.y0 = Math.min(box.y0, sy); box.y1 = Math.max(box.y1, sy);
        if (x < MARGIN || y < MARGIN || x >= MARGIN + c.width || y >= MARGIN + c.height) outCanvas++;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) { off++; if (pixels.length < SAMPLES) pixels.push([sx, sy]); }
      }
      if (off > worst.off) worst = { off, frame: i, pixels };
      if (outCanvas > past) { past = outCanvas; pastFrame = i; }
    });
    const t = (i: number) => Math.round((i * 1000) / fx.fps);
    if (worst.off) {
      out.push({ ...base, rule: "spill", severity: "error", count: worst.off, pixels: worst.pixels,
        message: `up to ${worst.off} px of the effect fall outside the ${W}x${H} sprite (at ${t(worst.frame)} ms; it draws over ${span(box)} with its origin at ${fx.x},${fx.y})`,
        fix: "move the effect inward (add_fx x, y), grow the canvas, or make the effect smaller" });
    }
    if (past) {
      out.push({ ...base, rule: "spill", severity: "warning", count: past, pixels: [],
        message: `up to ${past} px drawn past the effect's own ${c.width}x${c.height} canvas (at ${t(pastFrame)} ms), so they are cut off`,
        fix: fx.recipe ? "grow the recipe's size or move its origin, or slow the particles" : "use a smaller option (height, radius) or another effect" });
    }
  } else {
    let n = 0, frame = 0;
    const pixels: [number, number][] = [];
    imgs.forEach((img, f) => {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x > 0 && y > 0 && x < W - 1 && y < H - 1) continue;
        if (!img.data[(y * W + x) * 4 + 3]) continue;
        if (!n) frame = f + 1;
        n++;
        if (pixels.length < SAMPLES) pixels.push([x, y]);
      }
    });
    if (n) {
      out.push({ ...base, rule: "spill", severity: "warning", frame, count: n, pixels,
        message: `${n} px touch the sprite's edge (first in frame ${frame}): the effect is probably cut off there`,
        fix: "move the effect inward or grow the canvas" });
    }
  }

  const lit = imgs.map(litCount);
  const firstLit = lit.findIndex((n) => n > 0);
  let lastLit = -1;
  lit.forEach((n, i) => { if (n > 0) lastLit = i; });

  // A one-shot ends empty.
  if (fx && !fx.loop) {
    if (rec) {
      const c = fxCanvas(rec.e, rec.flip, rec.angle);
      const end = renderFx(rec.e.module, rec.opts, { times: [rec.e.durationMs / 1000], seed: rec.seed, canvas: c }).color[0];
      const pixels: [number, number][] = [];
      let n = 0;
      for (let y = 0; y < end.height; y++) for (let x = 0; x < end.width; x++) {
        if (!end.data[(y * end.width + x) * 4 + 3]) continue;
        n++;
        if (pixels.length < SAMPLES) pixels.push([x - c.x + fx.x, y - c.y + fx.y]);
      }
      if (n) {
        out.push({ ...base, rule: "one-shot-end", severity: "warning", count: n, pixels,
          message: `${n} px still drawn at t = duration (${rec.e.durationMs} ms): the one-shot pops off instead of fading out`,
          fix: fx.recipe ? "shorten the particles' life and delays, or end the phases earlier, so everything is gone by the duration" : "let it fade: a longer duration or shorter-lived parts" });
      }
    } else if (lastLit >= 0 && lastLit === imgs.length - 1) {
      out.push({ ...base, rule: "one-shot-end", severity: "warning", frame: lastLit + 1, count: lit[lastLit], pixels: [],
        message: `the one-shot still draws ${lit[lastLit]} px on the sprite's last frame (${lastLit + 1}): it is cut off when the animation ends`,
        fix: "add frames until it fades out, or start it earlier" });
    }
  }

  // A loop wraps without a jump.
  if (fx?.loop && firstLit >= 0 && imgs.length - firstLit >= 3) {
    const run = imgs.slice(firstLit);
    const steps = run.slice(0, -1).map((a, i) => diffCount(a, run[i + 1])).sort((a, b) => a - b);
    const typical = steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.9))] ?? 0;
    const pixels: [number, number][] = [];
    const seam = diffCount(run[run.length - 1], run[0], pixels);
    if (seam > Math.max(typical * 2, 12)) {
      out.push({ ...base, rule: "loop-seam", severity: "warning", frame: imgs.length, count: seam, pixels,
        message: `the loop jumps: ${seam} px change from frame ${imgs.length} back to frame ${firstLit + 1} (a normal step changes ${typical})`,
        fix: "make the frames cover a whole number of loops (frame durations adding up to the loop's duration), or re-add the effect" });
    }
  }

  // Colors.
  const max = o.maxColors ?? 24;
  const colors = new Set<number>();
  for (const img of imgs) for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= OPAQUE) colors.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
  if (colors.size > max) {
    out.push({ ...base, rule: "colors", severity: "warning", count: colors.size, pixels: [],
      message: `${colors.size} colors on the layer (more than ${max})`,
      fix: "use a shorter palette ramp, or add it with palette 'sprite' to snap it to the sprite palette" });
  }
  return out;
}

/** The FX layers check_fx looks at: one by id or name, else every layer with an FX record or named 'AI: fx …' (not glow). */
export function fxLayers(layers: LayerInfo[], which?: string): LayerInfo[] | string {
  if (which) {
    const l = layers.find((x) => x.id === which || x.name === which);
    if (!l) return `No layer ${which}. FX layers: ${(fxLayers(layers) as LayerInfo[]).map((x) => `${x.id} ${x.name}`).join(", ") || "none"}.`;
    if (l.group) return `${l.name} is a group; give an image layer.`;
    return [l];
  }
  return layers.filter((l) => !l.group && (l.fx || (l.name.startsWith("AI: fx ") && !l.name.endsWith(" glow"))));
}

async function runCheck(doc: Document, which: string | undefined, o: FxCheckOptions): Promise<ToolResult> {
  const info = await doc.info();
  const targets = fxLayers(info.layers, which);
  if (typeof targets === "string") return failure(targets);
  if (!targets.length) return { content: [text("FX check: no FX layers (none has an FX record or an 'AI: fx' name). Give layer to check another.")] };
  const findings: FxFinding[] = [];
  for (const l of targets) {
    const images: Rgba[] = [];
    for (let f = 1; f <= info.durations.length; f++) images.push(await doc.pixels(l.id, f));
    findings.push(...checkFxLayer(l, images, info, o));
  }
  return { content: [text(formatFxCheck(findings, targets, info.durations.length))] };
}

export function formatFxCheck(findings: FxFinding[], layers: LayerInfo[], frames: number): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const head = `FX check: ${errors} errors, ${findings.length - errors} warnings (${layers.length} layer${layers.length === 1 ? "" : "s"}: ` +
    `${layers.map((l) => `${l.id} ${l.name}${l.fx ? ` (${l.fx.id}, ${l.fx.loop ? "loop" : "one-shot"})` : " (no FX record)"}`).join(", ")}; ${frames} frames)`;
  if (!findings.length) return `${head}. No problems found.`;
  return [head, ...findings.map((f) => {
    const where = [`${f.layerId} ${f.layer}`, f.frame ? `frame ${f.frame}` : ""].filter(Boolean).join(", ");
    const at = f.pixels.length ? ` at ${f.pixels.map((p) => `(${p[0]},${p[1]})`).join(" ")}${f.count > f.pixels.length ? " …" : ""}` : "";
    return `- ${f.severity} ${f.rule} [${where}]: ${f.message}${at}\n  fix: ${f.fix}`;
  })].join("\n");
}

const RECIPE_HELP =
  "A recipe is JSON: { name ('blue-burst'), size [w, h] (8-256), origin [x, y] (the anchor point on that canvas), fps (default 30), " +
  "duration (s, up to 6), loop (default false), seed, palette (4-16 '#rrggbb', dark to bright), floor? (y px from the origin that " +
  "sparks and grit bounce on), anchor? ('center' or 'ground'), phases: [{ name: charge|flash|burst|linger|decay, start, end (s), " +
  "emitters?, lights?, rings?, bands?, shapes? }] }. Positions are px from the origin (y down), angles degrees (0 right, -90 up). " +
  "emitter: { kind: spark|mote|streak|flake|vapour|dust|star|ember|smoke|fire|brand|grit, count (up to 400), speed (px/s, or [min, max]), " +
  "angle (default -90), spread (degrees, default 360), life (s, or [min, max]), delay?, over? (spawn spread over s), size?, x?, y?, " +
  "radius? (spawn disc), color? (palette step: 0 darkest, -1 brightest; or '#hex'), gravity? (px/s², added), drag? (per s, added) }. " +
  "light: { radius, strength? (0-3), color?, delay?, life? }. ring: { radius (or [from, to] over the phase), width?, color? (or 'cool': " +
  "down the palette), alpha? (default [1, 0]), glow?, ease? (linear|in|out|inout) }. band (a ring on the floor plane): { radius, tilt? " +
  "(0.05-1, default 0.3), thickness?, alpha?, hot?, ease? }. shape: { type: disc|glow, radius, color?, alpha?, ease? }. A phase draws " +
  "rings, bands and shapes during [start, end); particles live on after it. A loop must wrap: particles may cross the seam (they do), " +
  "but rings and shapes should be gone or match at the end.";

export const FX_RECIPE_TOOLS: Tool[] = [
  {
    name: "fx_from_recipe",
    title: "Effect from recipe",
    description:
      "Make a game effect from a JSON recipe instead of picking one from the FX library: phases (charge, flash, burst, linger, " +
      "decay) of particle emitters, lights, rings, bands and shapes, in a palette ramp. apply 'preview' (default) returns " +
      "preview_fx's contact sheet; 'layer' adds it to the active sprite like add_fx (x, y, anchor, start_frame, glow; one undo " +
      "step); 'sprite' makes it its own sprite like new_fx_sprite. The FX record's id is 'recipe:<name>' and the recipe is " +
      "stored on the layer, so it can be tuned and checked (check_fx) later. Bad recipes fail with every problem listed. " +
      RECIPE_HELP,
    input: z.object({
      recipe: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The recipe, as an object or JSON text."),
      apply: z.enum(["preview", "layer", "sprite"]).optional().describe("Default 'preview'."),
      x: z.number().int().optional().describe("apply 'layer': where the effect's anchor goes. Default the sprite's center."),
      y: z.number().int().optional(),
      anchor: anchorInput,
      start_frame: z.number().int().min(1).optional().describe("apply 'layer': the first frame. Default the active frame."),
      glow: z.enum(["layer", "baked", "none"]).optional().describe("apply 'layer': as add_fx. Default 'layer'."),
    }),
    kind: "edit",
    label: (a) => (a?.apply === "layer" ? "Add effect from recipe" : a?.apply === "sprite" ? "New effect sprite from recipe" : "Preview recipe"),
    async run(input, ctx) {
      let recipe;
      try { recipe = parseRecipe(input.recipe); } catch (err) { return failure((err as Error).message); }
      const json = JSON.stringify(recipe);
      const e = recipeEntry(recipe);
      const apply = input.apply ?? "preview";
      if (apply === "preview") return previewFx(e, {});
      if (json.length > RECIPE_LIMITS.recipeChars) {
        return failure(`The recipe is ${json.length} characters as JSON; at most ${RECIPE_LIMITS.recipeChars} can be stored with the effect. Use fewer items.`);
      }
      if (apply === "sprite") return fxSprite(ctx, e, {}, { recipe: json });
      return placeFx(ctx, e, { x: input.x, y: input.y, anchor: input.anchor, start_frame: input.start_frame, glow: input.glow }, { recipe: json });
    },
  },
  {
    name: "check_fx",
    title: "Check effects",
    description:
      "Check effect layers (one, or every layer with an FX record or named 'AI: fx …') for what eyes miss, with coordinates and a fix: " +
      "spill (re-rendered from the layer's FX record at its origin: pixels outside the sprite, an error, or past the effect's own canvas, " +
      "where it was cut; without a record, pixels on the sprite's edge), one-shot-end (a one-shot that still draws at its duration, so it " +
      "pops off), loop-seam (a loop whose last frame jumps back to its first: more than twice a normal frame step and more than 12 px), " +
      "and colors (more distinct opaque colors than max_colors). Nothing changes. Run it after add_fx, fx_from_recipe or fx_overlay.",
    input: z.object({
      layer: z.string().optional().describe("A layer id ('L12') or name. Default every FX layer."),
      max_colors: z.number().int().min(1).max(256).optional().describe("Colors a layer may use. Default 24."),
    }),
    kind: "read",
    label: () => "Check effects",
    async run(input, ctx) {
      return runCheck(documentOf(ctx), input.layer, { maxColors: input.max_colors });
    },
  },
];
