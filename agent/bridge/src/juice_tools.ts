// Juice tools (#104): squash, stretch, wobble, bounce, shake, flash, pulse, spin, lean and pop made from a layer's
// own pixels. The math is sprite_fx/ (curves, pixel-safe warps, the per-frame plan); the write is sprite_fx/write.ts.
import * as z from "zod/v4";
import { hex, parseHex } from "./color.js";
import { documentOf } from "./document.js";
import { bounds } from "./image.js";
import { EASES, type Ease } from "./sprite_fx/curves.js";
import { JUICE_DEFAULTS, JUICE_EFFECTS, juicePlan, type JuiceEffect } from "./sprite_fx/juice.js";
import { flash, pivotOf, touchesEdge, upscale8, warp } from "./sprite_fx/raster.js";
import { effectPreview, imageLayer, writeEffect } from "./sprite_fx/write.js";
import { framesSpec } from "./tool_inputs.js";
import { failure, text, type Tool } from "./tool.js";

const effectList = JUICE_EFFECTS.map((e) => `${e} (${JUICE_DEFAULTS[e].what})`).join("; ");

export const JUICE_TOOLS: Tool[] = [
  {
    name: "juice",
    title: "Juice",
    description:
      "Make game-feel animation from a layer's own pixels, in one undo step: " + effectList + ". " +
      "Default placement inserts the effect's frames right after `frame` (other layers' cels there are linked to it, " +
      "tags covering it grow); `over` instead transforms existing frames (each frame's own art, e.g. a wobble across " +
      "an idle). The result goes on 'AI: juice <layer>' above the layer, which is hidden; every frame the effect does " +
      "not touch gets a copy of the layer, so nothing else changes. Transforms only move existing pixels (rotations " +
      "sample a Scale2x upscale, RotSprite's idea; shrinks keep 1 px details like eyes), so no new colors appear except flash's. " +
      "Returns a contact sheet of the effect's frames. preview: true shows it without changing the sprite.",
    input: z.object({
      effect: z.enum(JUICE_EFFECTS as [JuiceEffect, ...JuiceEffect[]]),
      layer: z.string().optional().describe("Layer id or name. Default the active layer."),
      frame: z.number().int().min(1).optional().describe("The frame whose art the effect uses and after which its frames go. Default the active frame."),
      over: framesSpec.optional().describe("Transform these existing frames instead of inserting new ones: 3, [1,2], '1-4', 'all'."),
      frames: z.number().int().min(1).max(48).optional().describe("How many frames the effect has (insert). Default per effect."),
      duration_ms: z.number().int().min(10).max(2000).optional().describe("Each inserted frame's duration. Default 50 (flash 60)."),
      pivot: z.union([z.enum(["bottom", "center", "top"]), z.object({ x: z.number(), y: z.number() })]).optional()
        .describe("What stays put: the content's bottom centre (feet), centre, top, or a sprite point. Default per effect."),
      amount: z.number().min(0).max(2).optional().describe("Strength 0..1 (squash, stretch, wobble, pulse, lean, pop_out's swell)."),
      px: z.number().int().min(1).max(256).optional().describe("Pixels: shake size, wobble sway at the top, bounce drop height."),
      cycles: z.number().min(0.25).max(8).optional().describe("Spring oscillations over the effect (squash, stretch, wobble, lean)."),
      damping: z.number().min(0).max(2).optional().describe("Spring damping ratio: 0.1 rings long, 1 settles without overshoot."),
      bounces: z.number().int().min(0).max(6).optional().describe("Bounces after the first landing. Default 2."),
      turns: z.number().min(-8).max(8).optional().describe("Spin turns over the effect; negative turns left. Default 1."),
      ease: z.enum(EASES as [Ease, ...Ease[]]).optional().describe("Easing for pulse, pop_in, pop_out."),
      color: z.string().optional().describe("Flash color. Default #ffffff."),
      seed: z.number().int().optional(),
      preview: z.boolean().optional().describe("Only show the contact sheet; the sprite does not change."),
    }),
    kind: "edit",
    label: (a) => `Juice: ${a.effect ?? ""}`,
    async run(input, ctx) {
      const doc = documentOf(ctx);
      const info = await doc.info();
      const layer = imageLayer(info, input.layer);
      if (!layer) return failure(`No image layer ${input.layer ?? "is active"}.`);
      const effect = input.effect as JuiceEffect;
      const def = JUICE_DEFAULTS[effect];
      const color = input.color ? parseHex(input.color) : { r: 255, g: 255, b: 255, a: 255 };
      if (!color) return failure(`color ${input.color} is not a hex color.`);
      const pivotAt = input.pivot ?? def.pivot;
      const opts = {
        amount: input.amount, px: input.px, cycles: input.cycles, damping: input.damping, bounces: input.bounces,
        turns: input.turns, ease: input.ease as Ease | undefined, seed: input.seed,
      };

      // Each output frame: which source frame it transforms and where it lands.
      const over = input.over !== undefined ? await doc.frames(input.over) : undefined;
      const anchorFrame = input.frame ?? info.frame;
      if (anchorFrame > info.durations.length) return failure(`Frame ${anchorFrame} is past the last frame (${info.durations.length}).`);
      const count = over ? over.length : input.frames ?? def.frames;
      const sources = over ?? Array.from({ length: count }, () => anchorFrame);
      const targets = over ?? Array.from({ length: count }, (_, i) => anchorFrame + 1 + i);

      const read = new Map<number, Awaited<ReturnType<typeof doc.pixels>>>();
      for (const f of new Set(sources)) read.set(f, await doc.pixels(layer.id, f));
      const first = read.get(sources[0])!;
      const { pivot, box } = pivotOf(first, pivotAt);
      if (!box) return failure(`${layer.name} has nothing in frame ${sources[0]} to animate.`);
      const plan = juicePlan(effect, count, box, opts);
      const bigs = new Map<number, ReturnType<typeof upscale8>>();
      const out = plan.map((p, i) => {
        const f = sources[i], src = read.get(f)!;
        // Each source frame pivots on its own content (over: the art may move between frames).
        const piv = over ? pivotOf(src, pivotAt).pivot : pivot;
        const needsBig = p.warp.rot || p.warp.wave || p.warp.kx || (p.warp.sx ?? 1) !== 1 || (p.warp.sy ?? 1) !== 1;
        if (needsBig && !bigs.has(f)) bigs.set(f, upscale8(src));
        const moved = warp(src, p.warp, piv, bigs.get(f));
        return p.flash ? flash(moved, color) : moved;
      });

      const cut = out.some((img, i) => touchesEdge(img) && !touchesEdge(read.get(sources[i])!));
      const preview = effectPreview(out, targets.map(String));
      const note = cut ? " Some frames reach the canvas edge, so part of the effect is cut; enlarge the canvas or lower amount/px." : "";
      if (input.preview) {
        return { content: [...(preview ? [preview] : []), text(`Preview of ${effect} on ${layer.name}: ${count} frames (nothing changed).${note}`)] };
      }
      const flashColor = effect === "flash" ? [hex(color)] : undefined;
      const ms = input.duration_ms ?? (effect === "flash" ? 60 : 50);
      const res = await writeEffect(doc, info, {
        source: layer.id, name: `juice ${layer.name}`,
        insert: over ? undefined : { after: anchorFrame, durations: Array(count).fill(ms) },
        frames: new Map(targets.map((f, i) => [f, out[i]])),
        palette: flashColor, label: `Juice: ${effect}`, prompt: `juice ${effect}`,
      });
      const where = over
        ? `transformed frames ${targets.join(", ")}`
        : `inserted ${count} frames of ${ms} ms after frame ${anchorFrame} (frames ${targets[0]}-${targets.at(-1)})`;
      const empty = out.filter((img) => !bounds(img, 1)).length;
      return {
        content: [
          ...(preview ? [preview] : []),
          text(`${effect} on ${layer.name}: ${where}, on ${res.layer} (${layer.name} hidden under it; ${res.frames} frames now).` +
            `${empty ? ` ${empty} frame${empty === 1 ? " is" : "s are"} empty by design (shrunk away).` : ""}${note} One undo step.`),
        ],
      };
    },
  },
];
