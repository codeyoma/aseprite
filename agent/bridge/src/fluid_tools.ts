// Fluid effects (#106): smoke, fire, gas and steam from a small Stable Fluids grid, and splashes and pours from
// PIC/FLIP particles, shaded to a palette ramp with Bayer dithering (sprite_fx/fluid.ts). One tool, fluid_fx:
// preview a contact sheet, put the effect on an 'AI: fx fluid <preset>' layer in one undo step, or make it a sprite.
import * as z from "zod/v4";
import { nearest, parseHex, type RGBA } from "./color.js";
import { documentOf, type PutImagesItem } from "./document.js";
import { freeLayerName, fxPalette, fxSchedule, placed } from "./fx_tools.js";
import { bounds, type Rgba } from "./image.js";
import { FLUID_PRESETS, FLUID_PRESET_NAMES, MAX_SIZE, renderFluid, type Emitter, type FluidPresetName, type FluidRender, type FluidSettings } from "./sprite_fx/fluid.js";
import { effectPreview, imageLayer } from "./sprite_fx/write.js";
import { failure, text, type Tool } from "./tool.js";

const presetList = FLUID_PRESET_NAMES.map((p) => `${p} (${FLUID_PRESETS[p].what})`).join("; ");

const emitterInput = z.object({
  shape: z.enum(["point", "disc", "line", "rect"]),
  x: z.number(), y: z.number(),
  x2: z.number().optional(), y2: z.number().optional(),
  w: z.number().min(1).optional(), h: z.number().min(1).optional(),
  r: z.number().min(0.5).max(64).optional(),
  vx: z.number().min(-400).max(400).optional(), vy: z.number().min(-400).max(400).optional(),
  radial: z.number().min(-400).max(400).optional(),
}).describe("Where the fluid comes from, in the effect canvas's pixels (0,0 top-left, y down): 'point' or 'disc' at x, y " +
  "(radius r), 'line' from x, y to x2, y2 (half-thickness r), 'rect' from x, y (top-left) of w x h. vx, vy: its velocity in " +
  "px/s (negative vy is up); radial: an outward push from its centre in px/s. For splash it is the falling blob, for pour the " +
  "spout. Default: the preset's.");

const BUSY_ALPHA = 1;

/** The busiest frame (most drawn pixels): the effect's impact, for the FX record's windup. */
function busiest(frames: Rgba[]): number {
  let best = 0, most = -1;
  frames.forEach((f, i) => {
    let n = 0;
    for (let k = 3; k < f.data.length; k += 4) if (f.data[k] >= BUSY_ALPHA) n++;
    if (n > most) { most = n; best = i; }
  });
  return best;
}

/** The ramp for the colors input: hex colors as given, 'sprite' snaps the preset's ramp to the sprite palette. */
function rampOf(colors: unknown, preset: FluidPresetName, spritePalette: RGBA[]): RGBA[] | string {
  if (colors === undefined) return [];
  if (colors === "sprite") {
    if (!spritePalette.length) return "The sprite palette has no colors to use.";
    const out: RGBA[] = [];
    for (const h of FLUID_PRESETS[preset].ramp) {
      const c = nearest(parseHex(h)!, spritePalette).color;
      if (!out.length || out.at(-1)!.r !== c.r || out.at(-1)!.g !== c.g || out.at(-1)!.b !== c.b) out.push({ ...c, a: 255 });
    }
    return out.length >= 2 ? out : "The sprite palette has no two colors along the preset's ramp; pass colors instead.";
  }
  const list = colors as string[];
  const parsed = list.map((h) => parseHex(h));
  const bad = list.find((_, i) => !parsed[i]);
  if (bad) return `Invalid color in colors: ${bad}`;
  return parsed.map((c) => ({ ...c!, a: 255 }));
}

export const FLUID_TOOLS: Tool[] = [
  {
    name: "fluid_fx",
    title: "Fluid effect",
    description:
      "Simulate a fluid and draw it as pixel art: gases on a small Stable Fluids grid (advection, pressure projection, " +
      "vorticity confinement, buoyancy from temperature, fuel that burns into heat for fire) and liquids as PIC/FLIP " +
      "particles. Presets: " + presetList + ". The field (smoke density, flame temperature, water depth) maps to a color " +
      "ramp with Bayer 4x4 dithering between steps; pixels are ramp colors or fully transparent, never blended. Loops " +
      "are seamless (the fields of a second cycle are crossfaded into the first before shading); one-shots end empty " +
      "(gases) or settled (liquids). Deterministic for a seed. apply: 'preview' (default) returns a contact sheet and " +
      "changes nothing; 'layer' puts it on a new 'AI: fx fluid <preset>' layer of the active sprite in one undo step, " +
      "with the emitter's centre at x, y (default the sprite centre), timed by the sprite's frame durations from " +
      "start_frame like add_fx (frames added past the end; loops fill every frame), its colors appended to the palette; " +
      "'sprite' makes it its own tagged sprite. emit_layer turns a layer's pixels into the source (the canvas is then the " +
      "whole sprite): smoke off a burning house, a slime that melts into water. The FX record's id is 'fluid:<preset>' " +
      "and its render holds these settings, so check_fx and export_for_engine see it like any effect.",
    input: z.object({
      preset: z.enum(FLUID_PRESET_NAMES as [FluidPresetName, ...FluidPresetName[]]),
      apply: z.enum(["preview", "layer", "sprite"]).optional().describe("Default 'preview'."),
      width: z.number().int().min(8).max(MAX_SIZE).optional().describe(`Effect canvas width in px (up to ${MAX_SIZE}). Default the preset's.`),
      height: z.number().int().min(8).max(MAX_SIZE).optional().describe(`Effect canvas height in px (up to ${MAX_SIZE}). Default the preset's.`),
      frames: z.number().int().min(2).max(96).optional().describe("Frame count. Default duration_ms x fps."),
      fps: z.number().int().min(4).max(30).optional().describe("Default 12 (pixel-art pace)."),
      duration_ms: z.number().int().min(100).max(8000).optional().describe("Length when frames is not given. Default the preset's."),
      loop: z.boolean().optional().describe("Seamless loop or one-shot. Default the preset's (smoke, torch, poison-gas, steam loop)."),
      seed: z.number().int().optional().describe("Another seed gives another variation. Default 1."),
      colors: z.union([z.literal("sprite"), z.array(z.string()).min(2)]).optional()
        .describe("The ramp, dark to bright (e.g. 4-7 colors), or 'sprite' to snap the preset's ramp to the sprite palette. Default the preset's ramp."),
      buoyancy: z.number().min(0).max(200).optional().describe("How hard heat lifts the gas (px/s² per unit). Default the preset's."),
      vorticity: z.number().min(0).max(60).optional().describe("Swirl: vorticity confinement strength. 0 is smooth, 20+ curly."),
      wind: z.union([z.number(), z.object({ x: z.number(), y: z.number() })]).optional()
        .describe("A steady drift in px/s: a number blows sideways (positive right), or { x, y }."),
      dissipation: z.number().min(0).max(10).optional().describe("How fast smoke thins out, per second."),
      gravity: z.number().min(0).max(2000).optional().describe("Liquids: gravity in px/s². Default 320."),
      strength: z.number().min(0.1).max(5).optional().describe("Source strength (1 = the preset's): more smoke, a bigger flame, a faster pour."),
      level: z.number().min(0).max(0.9).optional().describe("Liquids: the starting pool depth, 0..0.9 of the height."),
      emitter: emitterInput.optional(),
      emit_layer: z.string().optional().describe("A layer (id or name) whose pixels in start_frame are the source; the canvas is the whole sprite."),
      resolution: z.union([z.literal(1), z.literal(2)]).optional().describe("Grid cells per pixel. Default 2 for small gases (48 px a side or less), else 1."),
      threshold: z.number().min(0).max(0.9).optional().describe("Thin fluid below this (0..1) is transparent. Default 0.06."),
      x: z.number().int().optional().describe("layer: where the emitter's centre goes. Default the sprite centre."),
      y: z.number().int().optional(),
      start_frame: z.number().int().min(1).optional().describe("layer: the first frame it is on. Default the active frame."),
    }),
    kind: "edit",
    label: (a) => (a?.preset ? `Fluid: ${a.preset}` : "Fluid effect"),
    async run(input, ctx) {
      const preset = input.preset as FluidPresetName;
      const apply = (input.apply ?? "preview") as "preview" | "layer" | "sprite";
      const p = FLUID_PRESETS[preset];
      const fps = input.fps ?? p.fps;
      const frames = input.frames ?? (input.duration_ms ? Math.max(2, Math.round((input.duration_ms * fps) / 1000)) : undefined);
      const needsSprite = apply === "layer" || input.emit_layer !== undefined || input.colors === "sprite";
      const doc = needsSprite ? documentOf(ctx) : undefined;
      const info = doc ? await doc.info() : undefined;

      const ramp = rampOf(input.colors, preset, info?.palette ?? []);
      if (typeof ramp === "string") return failure(ramp);
      const settings: FluidSettings = {
        preset, width: input.width, height: input.height, frames, fps, loop: input.loop, seed: input.seed,
        ramp: ramp.length ? ramp : undefined, buoyancy: input.buoyancy, vorticity: input.vorticity,
        wind: typeof input.wind === "number" ? { x: input.wind, y: 0 } : input.wind, dissipation: input.dissipation,
        gravity: input.gravity, strength: input.strength, level: input.level, emitter: input.emitter as Emitter | undefined,
        resolution: input.resolution, threshold: input.threshold,
      };
      const start = input.start_frame ?? info?.frame ?? 1;
      if (info && start > info.durations.length) return failure(`start_frame ${start} is past the last frame (${info.durations.length}).`);
      let onSprite = false;
      if (input.emit_layer !== undefined) {
        const layer = imageLayer(info!, input.emit_layer);
        if (!layer) return failure(`No image layer ${input.emit_layer}.`);
        if (info!.width > MAX_SIZE || info!.height > MAX_SIZE) {
          return failure(`emit_layer makes the canvas the whole sprite, which must be ${MAX_SIZE}x${MAX_SIZE} or less (it is ${info!.width}x${info!.height}).`);
        }
        const img = await doc!.pixels(layer.id, start);
        const mask = new Uint8Array(img.width * img.height);
        for (let k = 0; k < mask.length; k++) mask[k] = img.data[k * 4 + 3];
        if (!mask.some((a) => a > 0)) return failure(`${layer.name} has no pixels in frame ${start} to emit from.`);
        Object.assign(settings, { width: img.width, height: img.height, mask });
        onSprite = true;
      }

      let r: FluidRender;
      try { r = renderFluid(settings); } catch (err) { return failure((err as Error).message); }
      const record = JSON.stringify(Object.fromEntries(Object.entries({
        ...input, apply: undefined, x: undefined, y: undefined, start_frame: undefined, frames: r.frames.length, fps: r.fps, loop: r.loop,
        seed: input.seed ?? 1,
      }).filter(([, v]) => v !== undefined)));
      const stats = `${r.frames.length} frames of ${r.width}x${r.height} at ${r.fps} fps (${r.durationMs} ms, ${r.loop ? "a seamless loop" : "a one-shot"}); ` +
        `grid ${r.grid.width}x${r.grid.height}, ${r.steps} steps, rendered in ${r.ms} ms; ${r.colors.length} colors (${r.colors.join(" ")})` +
        `${r.seam ? `; loop seam ${r.seam.last} px changed vs a median ${r.seam.median} px between frames` : ""}.`;
      const id = `fluid:${preset}`;
      const windupMs = Math.round((busiest(r.frames) * 1000) / r.fps);

      if (apply === "preview") {
        const sheet = effectPreview(r.frames, r.frames.map((_, i) => String(i + 1)));
        return { content: [...(sheet ? [sheet] : []), text(`Preview of ${preset}: ${stats} The emitter's centre is at ${r.origin.x},${r.origin.y} of the canvas. Nothing changed.`)] };
      }

      if (apply === "sprite") {
        const duration = Math.max(1, Math.round(1000 / r.fps));
        const name = `fluid-${preset}`;
        const res = await documentOf(ctx).createAnimation(r.width, r.height, r.frames.map((image) => ({ image, duration })), {
          title: name, tags: [{ name, from: 1, to: r.frames.length }], palette: r.colors,
          fx: { id, x: r.origin.x, y: r.origin.y, fps: r.fps, loop: r.loop, windupMs, render: record },
        });
        return { content: [text(`Made "${res.title}": ${stats} Tag ${name}, its colors as the palette; the emitter's centre is at ${r.origin.x},${r.origin.y}.`)] };
      }

      // layer: placed by the emitter's centre (or over the whole sprite for emit_layer), sampled at the sprite's frame times.
      const sprite = info!;
      const left = onSprite ? 0 : (input.x ?? Math.floor(sprite.width / 2)) - r.origin.x;
      const top = onSprite ? 0 : (input.y ?? Math.floor(sprite.height / 2)) - r.origin.y;
      const newMs = Math.max(1, Math.round(1000 / r.fps));
      const plan = fxSchedule(sprite.durations, start, r.durationMs, r.loop, newMs);
      const main = freeLayerName(sprite, `fluid ${preset}`);
      const items: PutImagesItem[] = [];
      for (const s of plan.samples) {
        const k = Math.min(r.frames.length - 1, Math.floor((s.t * r.fps) / 1000 + 1e-6));
        const c = placed(r.frames[k], left, top, sprite.width, sprite.height);
        if (c) items.push({ image: c.image, x: c.x, y: c.y, frame: s.frame, newLayer: main });
      }
      if (!items.length) return failure(`${preset} at ${left + r.origin.x},${top + r.origin.y} lands outside the ${sprite.width}x${sprite.height} sprite; nothing was added.`);
      const { append, note } = await fxPalette(doc!, sprite, items, input.colors === "sprite" ? "sprite" : undefined);
      const res = await doc!.putImages(items, {
        frames: plan.frames, duration: newMs, label: `Fluid: ${preset}`, prompt: `fluid_fx ${preset}`, palette: append,
        fx: { layer: `AI: ${main}`, id, x: left + r.origin.x, y: top + r.origin.y, fps: r.fps, loop: r.loop, windupMs, render: record },
      });
      const first = plan.samples[0].frame, last = plan.samples.at(-1)!.frame;
      const cut = r.frames.some((f) => {
        const b = bounds(f, 1);
        return b && (left + b.x < 0 || top + b.y < 0 || left + b.x + b.w > sprite.width || top + b.y + b.h > sprite.height);
      });
      return {
        content: [text(
          `Added ${preset} on ${res.layers[0]?.name ?? `AI: ${main}`}, frames ${first}-${last}` +
          `${res.added ? ` (${res.added} frame${res.added === 1 ? "" : "s"} added, ${newMs} ms each)` : ""}, ` +
          `${onSprite ? `emitting from ${input.emit_layer}` : `the emitter's centre at ${left + r.origin.x},${top + r.origin.y}`}. ${stats}${note}` +
          `${cut ? " Part of it reaches past the sprite's edge and is cut there." : ""} One undo step.`,
        )],
      };
    },
  },
];

