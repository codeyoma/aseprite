// FX on a character's timeline (#70): fx_overlay maps a library effect onto a tag or a run of frames, by
// resampling it at the sprite's frame times or by retiming the sprite (inserted frames whose character cels are
// linked), with its impact on a chosen frame; hit_stop freezes the contact frame, shakes it and flashes a layer.
// Both write through one put_images request (frame inserts, durations, a recorded hit, images): one undo step.
// The timing model (an impact time, a freeze that holds everything, a decaying shake) follows pixelfx's act
// data, which adapts Hollow Crown; no code is taken from it.
import * as z from "zod/v4";
import { documentOf, type Document, type FrameInsert, type PutImagesItem, type SpriteInfo, type TagInfo } from "./document.js";
import type { FxAnchor, FxEntry } from "./fx/library.js";
import { fxImpact, planPlacement, previewPlacement, writePlacement } from "./fx/place.js";
import { RECIPE_LIMITS, parseRecipe, recipeEntry } from "./fx/recipe.js";
import { effectOptions, fxCanvas, isFxLayerName } from "./fx/record.js";
import { anchorInput, hexList, isFailure, lookup, optionsInput, previewInput } from "./fx_tools.js";
import { bounds, type Rgba } from "./image.js";
import type { RGBA } from "./color.js";
import { failure, text, type Tool } from "./tool.js";

/** ms split into n whole parts (at least 1 each) that add up to ms, longer ones first. */
export function splitMs(ms: number, n: number): number[] {
  const base = Math.floor(ms / n), extra = ms - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface OverlayPlanInput {
  /** The sprite's frame durations (ms). */
  durations: number[];
  /** The frames the effect is mapped onto, 1-based and inclusive. */
  from: number;
  to: number;
  effectMs: number;
  loop: boolean;
  timing: "resample" | "retime";
  /** One effect frame (ms): the length of retimed and extended frames. */
  stepMs: number;
  /** Put the effect's impact (impactMs into it) at this frame's start. Default: the effect starts on `from`. */
  hitFrame?: number;
  impactMs?: number;
  /** A one-shot that runs past `to`: extend (frames after `to`, its cels linked) or cut. */
  overflow: "extend" | "cut";
}

export interface OverlayPlan {
  /** Frames to insert (numbered as before), without shift: every layer's cel links to the frame before. */
  inserts: FrameInsert[];
  /** Durations to set (numbered after the inserts): a retimed frame's first part. */
  durations: { frame: number; ms: number }[];
  /** The frames the effect lands on (numbered after the inserts) and its time there (ms; wrapped for loops). */
  samples: { frame: number; t: number }[];
  /** Frames inserted in all, and how many of them extend past `to`. */
  inserted: number;
  extended: number;
  /** The new range of frames the effect was mapped onto (after the inserts, extension included). */
  from: number;
  to: number;
  /** Effect time at the start of `from` (ms; above 0 when its start lies before the range, which is not shown). */
  offsetMs: number;
  /** Effect ms past the range that were cut (overflow 'cut'). */
  cutMs: number;
  /** hitFrame after the inserts. */
  hitFrame?: number;
}

/**
 * Maps an effect onto sprite frames from..to. Each frame (or, retimed, each part of it) shows the effect at its
 * start time: frame f's time in the range plus offsetMs, where offsetMs is 0 or, with hitFrame, impactMs minus the
 * hit frame's start, so the impact lands on the hit frame's first moment. A frame where a one-shot starts partway
 * shows its first moment. resample adds no frames unless a one-shot outlasts the range; retime splits each frame
 * the effect is on into round(d / stepMs) parts whose durations add up to d, so the sprite's timing stays and the
 * effect plays at its own rate. A loop wraps and covers the whole range; a one-shot that outlasts it is extended
 * by stepMs frames after `to` (overflow 'extend') or cut.
 */
export function overlayPlan(o: OverlayPlanInput): OverlayPlan {
  const { durations, from, to, effectMs: D, loop, stepMs } = o;
  const startOf = new Map<number, number>();
  let acc = 0;
  for (let f = from; f <= to; f++) { startOf.set(f, acc); acc += durations[f - 1]; }
  const rangeMs = acc;
  const offsetMs = o.hitFrame !== undefined ? (o.impactMs ?? 0) - startOf.get(o.hitFrame)! : 0;
  // Samples as (original frame, part); part 0 is the frame itself.
  const raw: { f: number; k: number; t: number }[] = [];
  const parts = new Map<number, number[]>();
  const firstMs: { f: number; ms: number }[] = [];
  const wrap = (t: number) => ((t % D) + D) % D;
  for (let f = from; f <= to; f++) {
    const s = startOf.get(f)! + offsetMs, d = durations[f - 1];
    if (!loop && !(s + d > 0 && s < D)) continue;
    const n = o.timing === "retime" ? Math.max(1, Math.round(d / stepMs)) : 1;
    const subs = splitMs(d, n);
    let u = s;
    subs.forEach((sd, k) => {
      if (loop) raw.push({ f, k, t: wrap(u) });
      else if (u + sd > 0 && u < D) raw.push({ f, k, t: Math.max(0, u) });
      u += sd;
    });
    if (n > 1) { parts.set(f, subs.slice(1)); firstMs.push({ f, ms: subs[0] }); }
  }
  let extended = 0, cutMs = 0;
  const endT = rangeMs + offsetMs;
  if (!loop && endT < D && endT + D > 0) {
    if (o.overflow === "extend") {
      extended = Math.ceil((D - endT) / stepMs);
      const before = parts.get(to) ?? [];
      for (let j = 0; j < extended; j++) raw.push({ f: to, k: 1 + before.length + j, t: endT + j * stepMs });
      parts.set(to, [...before, ...Array(extended).fill(stepMs)]);
    } else cutMs = D - Math.max(0, endT);
  }
  const inserts: FrameInsert[] = [...parts].sort((a, b) => a[0] - b[0]).map(([after, ds]) => ({ after, durations: ds }));
  const final = (f: number) => f + inserts.filter((x) => x.after < f).reduce((n, x) => n + x.durations.length, 0);
  const inserted = inserts.reduce((n, x) => n + x.durations.length, 0);
  return {
    inserts,
    durations: firstMs.map(({ f, ms }) => ({ frame: final(f), ms })),
    samples: raw.map(({ f, k, t }) => ({ frame: final(f) + k, t })),
    inserted, extended, from: final(from), to: final(to) + (parts.get(to)?.length ?? 0), offsetMs, cutMs,
    ...(o.hitFrame !== undefined ? { hitFrame: final(o.hitFrame) } : {}),
  };
}

// fxImpact lives in fx/place.ts (#97); re-exported for callers here.
export { fxImpact };

/**
 * The point of a layer the effect goes at: the centre of its opaque bounds (alpha 128 and up) for anchor
 * 'center', its bottom centre (the floor under the feet, one row below the lowest pixel) for 'ground'.
 */
export function layerAnchor(img: Rgba, anchor: FxAnchor): { x: number; y: number } | undefined {
  const b = bounds(img);
  if (!b) return undefined;
  return { x: b.x + Math.floor(b.w / 2), y: anchor === "ground" ? b.y + b.h : b.y + Math.floor(b.h / 2) };
}

/** The layer a reference names (an id like 'L12' or a name), image layers only. */
function findLayer(info: SpriteInfo, ref: string) {
  return info.layers.find((l) => !l.group && (l.id === ref || l.id === `L${ref}`)) ?? info.layers.find((l) => !l.group && l.name === ref);
}

/** "tag a 2-5 (was 2-4)" for the tags whose range changed. */
function tagChanges(before: TagInfo[], after: TagInfo[]): string[] {
  return after.flatMap((t) => {
    const b = before.find((x) => x.name === t.name);
    return b && (b.from !== t.from || b.to !== t.to) ? [`${t.name} ${t.from}-${t.to} (was ${b.from}-${b.to})`] : [];
  });
}

const range = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`);
const total = (ds: number[]) => ds.reduce((a, b) => a + b, 0);

/**
 * A hit-stop: the contact frame holds freezeMs longer in all. With a shake of shakeMs (at most freezeMs), that
 * much of the freeze is spent on shake frames inserted after the contact frame, so the contact frame grows by
 * freezeMs - shakeMs and the total grows by exactly freezeMs. There are max(2, round(shakeMs / stepMs)) shake
 * frames; frame i is moved |x| = round(amp * (n - 1 - i) / (n - 1)) px sideways, right, left, right, ..., so the
 * shake decays to 0 on its last frame.
 */
export function hitStopPlan(freezeMs: number, shake?: { amp: number; ms: number }, stepMs = 33):
  { contactExtra: number; shakeMs: number; durations: number[]; offsets: { x: number; y: number }[]; clamped: boolean } {
  if (!shake || shake.amp <= 0 || shake.ms <= 0 || freezeMs < 2) return { contactExtra: freezeMs, shakeMs: 0, durations: [], offsets: [], clamped: false };
  const shakeMs = Math.min(shake.ms, freezeMs);
  const n = Math.min(shakeMs, Math.max(2, Math.round(shakeMs / stepMs)));
  const offsets = Array.from({ length: n }, (_, i) => {
    const m = Math.round((shake.amp * (n - 1 - i)) / (n - 1));
    return { x: m === 0 ? 0 : i % 2 === 0 ? m : -m, y: 0 };
  });
  return { contactExtra: freezeMs - shakeMs, shakeMs, durations: splitMs(shakeMs, n), offsets, clamped: shake.ms > freezeMs };
}

/** The frame (numbered before the inserts) whose art a frame numbered after them shows. */
export function originalFrame(inserts: FrameInsert[], frame: number): number {
  let f = frame;
  for (const ins of [...inserts].sort((x, y) => x.after - y.after)) {
    const n = ins.durations.length;
    if (f <= ins.after) break;
    f = f <= ins.after + n ? ins.after : f - n;
  }
  return f;
}

/** The pixels of a layer's frame turned white (alpha kept), cut to them; undefined when it is empty. */
async function whiteOf(doc: Document, layer: string, frame: number): Promise<{ image: Rgba; x: number; y: number } | undefined> {
  const img = await doc.pixels(layer, frame);
  const b = bounds(img, 1);
  if (!b) return undefined;
  const data = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const a = img.data[((b.y + y) * img.width + b.x + x) * 4 + 3];
      if (a) data.set([255, 255, 255, a], (y * b.w + x) * 4);
    }
  }
  return { image: { width: b.w, height: b.h, data }, x: b.x, y: b.y };
}

export const FX_TIMING_TOOLS: Tool[] = [
  {
    name: "fx_overlay",
    title: "Effect on an animation",
    description:
      "Put an effect from the FX library (id) or a recipe (as fx_from_recipe takes) onto a character's animation (a tag, or the frames from start_frame), in one " +
      "undo step, timed to the action: hit_frame puts the effect's impact (its act hit for melee effects, else its " +
      "busiest frame) on that frame's first moment. timing 'resample' (default) shows the effect at each frame's start " +
      "time and adds no frames. A one-shot that runs past the range: overflow 'cut' (default with a tag: the tag is " +
      "the action's length) ends it on the range's last frame; 'extend' (default with start_frame) adds frames " +
      "after it (1000/fps ms each, the character's cels linked so it holds its last pose; a tag that ends there grows). timing 'retime' plays the effect at its own fps: each frame it is " +
      "on is split into frames of about 1000/fps ms that add up to its duration, the character's cels in the new " +
      "frames LINKED to the frame they split (not copied), tags covering it grow. Place it with x, y, or with " +
      "anchor_layer: the effect goes at that layer's opaque bounds at hit_frame (else the first frame), the centre " +
      "for anchor 'center', the bottom centre (the ground under the feet) for 'ground', and stays there (effects " +
      "are in world space; they do not follow the body). With anchor_layer the default anchor is 'ground' for melee " +
      "effects (their origin is the character's feet) and the effect's own otherwise. flip mirrors it for a " +
      "character facing left. Layers, glow and palette work as in add_fx. The reply gives the impact frame and the " +
      "hit-stop the effect's act data suggests (for hit_stop). preview: true shows the placement over the animation's " +
      "frames instead (nothing changes).",
    input: z.object({
      id: z.string().optional().describe("Effect id from list_fx, e.g. 'sword-slash'. Or recipe."),
      recipe: z.union([z.string(), z.record(z.string(), z.unknown())]).optional()
        .describe("A recipe (fx_from_recipe's format, object or JSON text) instead of id, for effects the library lacks; stored on the layer."),
      x: z.number().int().optional().describe("Where the effect's anchor goes (with y). Or use anchor_layer. Default: the sprite's centre."),
      y: z.number().int().optional(),
      anchor_layer: z.string().optional().describe("Put the effect at this layer's opaque bounds (the character), at hit_frame or the range's first frame."),
      anchor: anchorInput,
      tag: z.string().optional().describe("The animation to map onto (a tag name). Or start_frame."),
      start_frame: z.number().int().min(1).optional().describe("Map onto the frames from here to the last. Default the active frame (without tag)."),
      flip: z.boolean().optional().describe("Mirror it (directional effects face right)."),
      timing: z.enum(["resample", "retime"]).optional().describe("Default 'resample' (no new frames when the effect fits)."),
      hit_frame: z.number().int().min(1).optional().describe("The sprite frame (in the range) the effect's impact lands on. Default: the effect starts on the range's first frame."),
      overflow: z.enum(["extend", "cut"]).optional().describe("A one-shot that runs past the range. Default 'cut' with a tag, 'extend' with start_frame."),
      seed: z.number().int().optional().describe("Another seed gives another variation of sparks and debris."),
      palette: z.union([z.literal("sprite"), hexList]).optional()
        .describe("'sprite': snap to the sprite palette; or the effect's main ramp, dark to bright. Default: the effect's colors, appended to the sprite palette."),
      light: z.number().min(0).max(4).optional().describe("Glow strength. Default 1."),
      glow: z.enum(["layer", "baked", "none"]).optional().describe("Default 'layer' (an Addition layer)."),
      fps: z.number().min(1).max(60).optional().describe("The effect's frame rate for retimed and extended frames. Default its own (usually 30)."),
      options: optionsInput,
      preview: previewInput,
    }),
    kind: "edit",
    label: (a) => (a?.preview ? "Preview effect on the animation" : a?.id ? `Effect ${a.id} on the animation` : a?.recipe ? "Recipe effect on the animation" : "Effect on the animation"),
    async run(input, ctx) {
      if ((input.id === undefined) === (input.recipe === undefined)) return failure("Give id (a library effect) or recipe, one of them.");
      let e: FxEntry, recipeJson: string | undefined;
      if (input.recipe !== undefined) {
        try { e = recipeEntry(parseRecipe(input.recipe)); } catch (err) { return failure((err as Error).message); }
        recipeJson = JSON.stringify(parseRecipe(input.recipe));
        if (recipeJson.length > RECIPE_LIMITS.recipeChars) {
          return failure(`The recipe is ${recipeJson.length} characters as JSON; at most ${RECIPE_LIMITS.recipeChars} can be stored with the effect. Use fewer items.`);
        }
      } else {
        const found = lookup(input.id!);
        if (isFailure(found)) return found;
        e = found;
      }
      const doc = documentOf(ctx);
      const info = await doc.info();
      let opts: Record<string, unknown>;
      try { opts = effectOptions(e, input); } catch (err) { return failure((err as Error).message); }
      const n = info.durations.length;
      if (input.tag !== undefined && input.start_frame !== undefined) return failure("Give tag or start_frame, not both.");
      let from: number, to: number, where: string;
      if (input.tag !== undefined) {
        const t = info.tags.find((x) => x.name === input.tag);
        if (!t) return failure(`No tag named ${input.tag}. Tags: ${info.tags.map((x) => `${x.name} ${x.from}-${x.to}`).join(", ") || "none"}.`);
        from = t.from; to = t.to; where = `tag ${t.name}`;
      } else {
        from = input.start_frame ?? info.frame; to = n; where = "frames";
        if (from > n) return failure(`start_frame ${from} is past the last frame (${n}).`);
      }
      if (input.hit_frame !== undefined && (input.hit_frame < from || input.hit_frame > to)) {
        return failure(`hit_frame ${input.hit_frame} is outside ${where} ${range(from, to)}.`);
      }
      if (input.anchor_layer !== undefined && (input.x !== undefined || input.y !== undefined)) {
        return failure("Give x, y or anchor_layer, not both.");
      }
      const canvas = fxCanvas(e, !!input.flip, 0);
      const seed = input.seed ?? e.seed;
      const anchor: FxAnchor = input.anchor ?? (input.anchor_layer !== undefined && e.category === "melee" ? "ground" : e.anchor);
      // Where: x, y; or the anchor layer's bounds at the hit frame (else the first), fixed for the whole effect.
      let ax = input.x ?? Math.floor(info.width / 2), ay = input.y ?? Math.floor(info.height / 2), placeNote = "";
      if (input.anchor_layer !== undefined) {
        const l = findLayer(info, input.anchor_layer);
        if (!l) return failure(`No image layer ${input.anchor_layer}. Layers: ${info.layers.filter((x) => !x.group).map((x) => x.name).join(", ")}.`);
        const at = input.hit_frame ?? from;
        const p = layerAnchor(await doc.pixels(l.id, at), anchor);
        if (!p) return failure(`${l.name} has no opaque pixels in frame ${at} to anchor the effect to.`);
        ax = p.x; ay = p.y;
        placeNote = ` (${anchor === "ground" ? "the bottom centre" : "the centre"} of ${l.name} in frame ${at})`;
      }
      const fps = input.fps ?? e.fps;
      const stepMs = Math.max(1, Math.round(1000 / fps));
      const impact = fxImpact(e, opts, seed, canvas);
      const plan = overlayPlan({
        durations: info.durations, from, to, effectMs: e.durationMs, loop: e.loop, timing: input.timing ?? "resample",
        stepMs, hitFrame: input.hit_frame, impactMs: impact.ms, overflow: input.overflow ?? (input.tag !== undefined ? "cut" : "extend"),
      });
      if (!plan.samples.length) return failure(`${e.id} does not fall on ${where} ${range(from, to)} with this hit_frame.`);
      let snap: RGBA[] | undefined;
      if (input.palette === "sprite") {
        snap = info.palette;
        if (!snap.length) return failure("The sprite palette has no colors to snap to.");
      }
      const pl = planPlacement(info, {
        e, opts, render: input, seed, canvas, anchor, x: ax, y: ay, samples: plan.samples, glow: input.glow ?? "layer", snap, fps,
        recipe: recipeJson,
      });
      if (!pl) return failure(`${e.id} at ${ax},${ay} lands outside the ${info.width}x${info.height} sprite; nothing was added.`);
      if (input.preview) {
        return { content: [await previewPlacement(doc, info, pl, { sourceOf: (f) => originalFrame(plan.inserts, f) }), text(
          `Preview of ${e.title} (${e.id}) on ${where} ${range(from, to)}: it would show on frames ${range(plan.samples[0].frame, plan.samples.at(-1)!.frame)} ` +
          `(numbered after ${plan.inserted} inserted frame${plan.inserted === 1 ? "" : "s"}) at effect times ` +
          `${plan.samples.slice(0, 12).map((s) => Math.round(s.t)).join(", ")}${plan.samples.length > 12 ? ", …" : ""} ms` +
          `${input.hit_frame !== undefined ? `, its impact (${impact.ms} ms in) on frame ${plan.hitFrame}` : ""}; each frame shows the animation with the ` +
          "effect as fx_overlay would place it (same timing, impact, cut, palette, glow and seed). Nothing changed.")] };
      }
      const { res, paletteNote } = await writePlacement(doc, info, pl, {
        palette: input.palette, insert: plan.inserts, durations: plan.durations, label: `Effect ${e.id} on the animation`, prompt: `fx_overlay ${e.id}`,
      });
      const after = await doc.info();
      const first = plan.samples[0].frame, last = plan.samples.at(-1)!.frame;
      const hitFinal = plan.hitFrame;
      const lines = [
        `Put ${e.title} (${e.id}) on ${where} ${range(from, to)} with its ${anchor === "center" ? "visual centre" : "origin"} at ${ax},${ay}${placeNote}` +
          `${input.flip ? ", flipped" : ""}; it shows on frames ${range(first, last)}${e.loop ? ", looping" : ""}.`,
        input.timing === "retime"
          ? `Retimed to ${fps} fps: ${plan.inserted - plan.extended} frame${plan.inserted - plan.extended === 1 ? "" : "s"} inserted inside the range (durations split so its timing stays), the character's cels in them linked.`
          : "Resampled at each frame's start time.",
      ];
      if (input.hit_frame !== undefined) {
        lines.push(`Its impact (${impact.from}, ${impact.ms} ms in) lands on frame ${hitFinal} (was ${input.hit_frame}).` +
          (plan.offsetMs > 0 ? ` Its first ${plan.offsetMs} ms fall before the range and are not shown.` : ""));
      }
      if (plan.extended) lines.push(`It outlasts the range, so ${plan.extended} frame${plan.extended === 1 ? "" : "s"} of ${stepMs} ms were inserted after it (the character's cels linked to its last frame).`);
      if (plan.cutMs) lines.push(`It outlasts the range by ${plan.cutMs} ms, which were cut, so its fade-out is lost (overflow 'extend' adds frames for them, the character holding its last pose).`);
      const grown = tagChanges(info.tags, after.tags);
      if (grown.length) lines.push(`Tags: ${grown.join(", ")}.`);
      lines.push(`Layers: ${res.layers.map((l) => (l.name.endsWith(" glow") ? `${l.name} (Addition)` : l.name)).join(", ")}.${paletteNote} One undo step.`);
      if (impact.act && hitFinal !== undefined && impact.act.freezeMs > 0) {
        const shakeMs = Math.min(impact.act.shakeMs, impact.act.freezeMs);
        lines.push(`Its act data suggests a hit-stop: hit_stop { frame: ${hitFinal}, freeze_ms: ${impact.act.freezeMs}` +
          `${shakeMs && impact.act.amp ? `, shake: { amp: ${impact.act.amp}, ms: ${shakeMs} }` : ""} }.`);
      }
      return { content: [text(lines.join(" "))] };
    },
  },
  {
    name: "hit_stop",
    title: "Hit-stop",
    description:
      "Freeze an animation on its contact frame, in one undo step: the contact pose holds freeze_ms longer in all, so " +
      "the animation grows by exactly freeze_ms. shake spends shake.ms of that freeze (at most freeze_ms) on shake " +
      "frames inserted after the contact frame: max(2, round(ms / 33)) frames whose cels on the character's layers " +
      "(every visible image layer but 'AI: fx' ones, or shake.layers) are moved sideways, right, left, right, by " +
      "amp px decaying to 0 on the last one; the other layers' cels are linked to the contact frame. The contact " +
      "frame keeps the rest of the freeze. flash_layer turns that layer's cel in the contact frame white (alpha " +
      "kept), that frame only. Tags covering the frame grow. The hit (frame, freeze, shake) is recorded on the " +
      "sprite (aseprite-agent property fx.hits) for exporters.",
    input: z.object({
      frame: z.number().int().min(1).optional().describe("The contact frame. Default the active frame."),
      freeze_ms: z.number().int().min(1).max(5000).describe("How much longer the contact pose holds, shake included (ms), e.g. 60-150."),
      shake: z.object({
        amp: z.number().int().min(1).max(16).describe("Shake size in px at the start."),
        ms: z.number().int().min(1).describe("How long it shakes (ms); taken out of freeze_ms."),
        layers: z.array(z.string()).optional().describe("Layers to shake (names or ids). Default the character's: visible image layers but 'AI: fx' ones."),
      }).optional(),
      flash_layer: z.string().optional().describe("Turn this layer white in the contact frame (e.g. the target being hit)."),
    }),
    kind: "edit",
    label: () => "Hit-stop",
    async run(input, ctx) {
      const doc = documentOf(ctx);
      const info = await doc.info();
      const n = info.durations.length;
      const frame = input.frame ?? info.frame;
      if (frame > n) return failure(`Frame ${frame} is past the last frame (${n}).`);
      const plan = hitStopPlan(input.freeze_ms, input.shake);
      let shakeLayers: string[] = [];
      if (plan.durations.length) {
        if (input.shake?.layers?.length) {
          for (const ref of input.shake.layers) {
            const l = findLayer(info, ref);
            if (!l) return failure(`No image layer ${ref} to shake.`);
            shakeLayers.push(l.id);
          }
        } else {
          shakeLayers = info.layers.filter((l) => !l.group && l.visible && !isFxLayerName(l.name)).map((l) => l.id);
        }
      }
      const items: PutImagesItem[] = [];
      let flashNote = "";
      if (input.flash_layer !== undefined) {
        const l = findLayer(info, input.flash_layer);
        if (!l) return failure(`No image layer ${input.flash_layer} to flash.`);
        const white = await whiteOf(doc, l.id, frame);
        if (white) {
          items.push({ image: white.image, x: white.x, y: white.y, frame, layer: l.id });
          flashNote = ` ${l.name} flashes white in frame ${frame}.`;
        } else flashNote = ` ${l.name} has nothing in frame ${frame} to flash.`;
      }
      const before = total(info.durations);
      const contactMs = info.durations[frame - 1] + plan.contactExtra;
      const insert: FrameInsert[] = plan.durations.length
        ? [{ after: frame, durations: plan.durations, shift: { layers: shakeLayers, offsets: plan.offsets } }] : [];
      await doc.putImages(items, {
        insert, durations: [{ frame, ms: contactMs }], label: "Hit-stop", prompt: "hit_stop",
        hit: { frame, freezeMs: input.freeze_ms, ...(plan.shakeMs ? { shakeMs: plan.shakeMs, amp: input.shake!.amp } : {}) },
      });
      const after = await doc.info();
      const lines = [`Hit-stop on frame ${frame}: it now lasts ${contactMs} ms (was ${info.durations[frame - 1]}).`];
      if (plan.durations.length) {
        const names = shakeLayers.map((id) => info.layers.find((l) => l.id === id)?.name ?? id);
        lines.push(`Shake: ${plan.durations.length} frames inserted at ${range(frame + 1, frame + plan.durations.length)} ` +
          `(${plan.durations.join(", ")} ms) with ${names.join(", ") || "no layers"} moved by x ${plan.offsets.map((o) => o.x).join(", ")} px; ` +
          `the other layers' cels are linked to frame ${frame}.` +
          (plan.clamped ? ` The shake was cut to ${plan.shakeMs} ms to fit in the freeze.` : ""));
      }
      lines.push(`The animation went from ${before} to ${total(after.durations)} ms (+${input.freeze_ms}).${flashNote}`);
      const grown = tagChanges(info.tags, after.tags);
      if (grown.length) lines.push(`Tags: ${grown.join(", ")}.`);
      lines.push("The hit is recorded on the sprite (fx.hits) for export. One undo step.");
      return { content: [text(lines.join(" "))] };
    },
  },
];
