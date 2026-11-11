// Effect pipelines (#107): fx_pipeline runs a JSON step chain (sprite_fx/pipeline.ts) over a layer's frames or a
// blank canvas and previews it, or writes it in one put_images request: over a layer through the sprite-effect
// seam (sprite_fx/write.ts: 'AI: fx <name>' above the layer, which is hidden), or onto a new layer for a blank
// canvas. The pipeline's JSON, with its source resolved (the layer and frame, or the canvas's place), is stored as the
// layer's FX record (id 'pipeline:<name>', in `recipe`), so it can be read back, re-tuned and re-rendered (check_fx).
// Re-applying a pipeline of the same name replaces its effect (#97): the old layer is emptied in the same request
// (put_images' clear) and rewritten, its original source and frames reused.
import * as z from "zod/v4";
import { documentOf, type LayerInfo } from "./document.js";
import { AI_PREFIX, aiLayer, buildRecord, freeLayerName } from "./fx/record.js";
import { blank, bounds, trim, type Rgba } from "./image.js";
import { PIPELINE_LIMITS, STEP_TYPES, canvasOf, parsePipeline, runPipeline, type Pipeline } from "./sprite_fx/pipeline.js";
import { effectPreview, imageLayer, writeEffect } from "./sprite_fx/write.js";
import { failure, text, type Tool } from "./tool.js";

const stepList = () => [...STEP_TYPES.values()].map((s) => s.what).join("; ");

const PIPELINE_HELP =
  "A pipeline is JSON: { name ('burn-away'), source? (a layer name, { layer?, frame? } (default the active layer and frame), or a " +
  "blank canvas { w, h, x?, y?, frame? } (up to 256; x, y its top-left on the sprite, default centred)), frames? (a count, default " +
  "8: inserted after the frame for a layer, from the frame on for a canvas, frames added at the end as needed; or { over: 3 | [1, 2] " +
  "| '1-4' | 'all' } to run over existing frames, each frame's own art), fps? (inserted frames' rate, default 12), loop? (time " +
  "wraps: frame i is phase i/n and noise loops), seed?, palette? (the working colors; default the sprite palette; palette steps " +
  "count from 0 darkest to -1 brightest), steps: [{ type, ...params }] (up to 16, run in order on each frame) }. Any numeric " +
  "param may be animated over the effect's time t (0 first frame, 1 last): a number, { from, to, ease? } or { keys: [[t, v], " +
  "...], ease? }. Colors are a palette step or '#rrggbb'. noise: { kind: value|perlin|simplex|worley, scale (feature px), " +
  "octaves (fBm), lacunarity, gain, seed }. Steps: ";

export const PIPELINE_TOOLS: Tool[] = [
  {
    name: "fx_pipeline",
    title: "Effect pipeline",
    description:
      "Make an effect from a JSON chain of steps over a layer's frames or a blank canvas, node-graph style: outlines, " +
      "dissolves, displacement, gradient maps, glows, noise fills, palette mapping, tints, flashes, offsets and juice, each " +
      "param animatable over time. Buffers stay at native resolution and only palette colors are written (every pixel ends " +
      "on the palette, the colors the steps name or the source's own). apply 'preview' (default) returns a contact sheet and " +
      "changes nothing; 'layer' writes it in one undo step: over a layer onto 'AI: fx <name>' above it with the layer hidden " +
      "(frames the effect does not fill get a copy of the layer), or for a blank canvas onto a new 'AI: fx <name>' layer. " +
      "The pipeline's JSON is stored on the layer as its FX record (id 'pipeline:<name>'), so it can be read back and " +
      "re-tuned. Re-applying a pipeline of the same name replaces its effect in one undo step (replace, default true): its " +
      "layer is emptied and rewritten, from the same source layer and frame unless the new pipeline names others, and " +
      "over the frames the earlier run inserted (only extra frames are inserted); replace false adds another layer. " +
      "Bad pipelines fail with every problem listed by path. " +
      PIPELINE_HELP + stepList() + ".",
    input: z.object({
      pipeline: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The pipeline, as an object or JSON text."),
      apply: z.enum(["preview", "layer"]).optional().describe("Default 'preview'."),
      replace: z.boolean().optional().describe("apply 'layer': replace the effect of an earlier run with the same name. Default true; false adds another 'AI: fx <name> 2' layer."),
    }),
    kind: "edit",
    label: (a) => (a?.apply === "layer" ? "Apply effect pipeline" : "Preview effect pipeline"),
    async run(input, ctx) {
      let p: Pipeline;
      try { p = parsePipeline(input.pipeline); } catch (err) { return failure((err as Error).message); }
      const apply = input.apply ?? "preview";
      const doc = documentOf(ctx);
      const info = await doc.info();
      // An earlier run of this pipeline (its FX record), replaced unless replace is false.
      const id = `pipeline:${p.name}`;
      const old = input.replace === false ? undefined
        : info.layers.find((l) => !l.group && l.fx?.id === id && l.name.startsWith(AI_PREFIX));
      let was: Pipeline | undefined;
      try { was = old?.fx?.recipe ? parsePipeline(old.fx.recipe) : undefined; } catch { was = undefined; }
      const layerName = old ? old.name.slice(AI_PREFIX.length) : freeLayerName(info, p.name);
      const canvas = canvasOf(p);
      const fps = p.fps ?? 12, ms = Math.max(1, Math.round(1000 / fps));
      const over = p.frames !== undefined && typeof p.frames === "object" ? await doc.frames(p.frames.over) : undefined;
      const count = over ? over.length : (p.frames as number | undefined) ?? 8;
      const seconds = `${count} frames${p.loop ? ", looping" : ""}`;
      const tooLong = (json: string) => json.length > PIPELINE_LIMITS.json
        ? failure(`The pipeline is ${json.length} characters as JSON; at most ${PIPELINE_LIMITS.json} can be stored with the effect. Use fewer steps.`) : undefined;
      const replaced = old ? ` (replacing the earlier run on ${old.name})` : "";

      if (canvas) {
        const wasCanvas = was ? canvasOf(was) : undefined;
        const start = canvas.frame ?? wasCanvas?.frame ?? info.frame;
        const targets = over ?? Array.from({ length: count }, (_, i) => start + i);
        const res = runPipeline(p, targets.map(() => blank(canvas.w, canvas.h)), info.palette);
        const x = canvas.x ?? wasCanvas?.x ?? Math.floor((info.width - canvas.w) / 2), y = canvas.y ?? wasCanvas?.y ?? Math.floor((info.height - canvas.h) / 2);
        const onSprite = res.frames.map((f) => { const big = blank(info.width, info.height); stampAt(big, f, x, y); return big; });
        const preview = effectPreview(onSprite, targets.map(String));
        const empty = res.frames.every((f) => !bounds(f, 1));
        if (apply === "preview" || empty) {
          return { content: [...(preview ? [preview] : []), text(`Preview of pipeline ${p.name} on a ${canvas.w}x${canvas.h} canvas at ${x},${y}: ${seconds}${empty ? "; every frame is empty, so nothing would be written" : ""} (nothing changed).`)] };
        }
        // Stored with its place resolved, so check_fx re-renders it where it is and a re-apply keeps it there.
        const json = JSON.stringify({ ...p, source: { ...canvas, x, y, frame: start } });
        const long = tooLong(json);
        if (long) return long;
        const items = res.frames.flatMap((f, i) => {
          const t = trim(f, 1);
          return bounds(f, 1) ? [{ image: t as Rgba, frame: targets[i], x: x + t.x, y: y + t.y, newLayer: layerName }] : [];
        });
        const last = Math.max(...targets);
        const fx = { layer: aiLayer(layerName), ...buildRecord({ id, x: x + Math.floor(canvas.w / 2), y: y + Math.floor(canvas.h / 2), fps, loop: !!p.loop, windupMs: 0, recipe: json }) };
        const put = await doc.putImages(items, {
          frames: last > info.durations.length ? last : undefined, duration: ms, clear: old ? [old.id] : undefined,
          label: `Effect pipeline ${p.name}`, prompt: `fx_pipeline ${p.name}`, palette: res.added.length ? res.added : undefined, fx,
        });
        return {
          content: [...(preview ? [preview] : []), text(`Pipeline ${p.name} on ${put.layers[0]?.name ?? aiLayer(layerName)}${replaced}: ${seconds} on frames ${targets[0]}-${targets.at(-1)}` +
            `${put.added ? ` (${put.added} frame${put.added === 1 ? "" : "s"} added, ${ms} ms each)` : ""}` +
            `${res.added.length ? `; ${res.added.length} color${res.added.length === 1 ? "" : "s"} added to the palette` : ""}. FX record ${id}. One undo step.`)],
        };
      }

      // Over a layer. A re-apply whose source is unnamed (or names the effect itself) uses the earlier run's source.
      const wasSource = was && !canvasOf(was) ? (typeof was.source === "string" ? { layer: was.source } : (was.source as { layer?: string; frame?: number } | undefined)) : undefined;
      const given = typeof p.source === "string" ? { layer: p.source } : (p.source as { layer?: string; frame?: number } | undefined);
      let layer: LayerInfo | undefined = imageLayer(info, given?.layer);
      if (old && (!layer || layer.id === old.id)) {
        layer = wasSource?.layer ? imageLayer(info, wasSource.layer) : undefined;
        if (!layer || layer.id === old.id) {
          return failure(`${old.name} holds an earlier run of ${p.name} without a source layer on record; name the source (source: { layer }) to re-apply it.`);
        }
      }
      if (!layer) return failure(`No image layer ${given?.layer ?? "is active"}.`);
      const anchor = given?.frame ?? (old ? wasSource?.frame : undefined) ?? info.frame;
      if (anchor > info.durations.length) return failure(`Frame ${anchor} is past the last frame (${info.durations.length}).`);
      const sources = over ?? Array.from({ length: count }, () => anchor);
      const targets = over ?? Array.from({ length: count }, (_, i) => anchor + 1 + i);
      const read = new Map<number, Rgba>();
      for (const f of new Set(sources)) read.set(f, await doc.pixels(layer.id, f));
      if (![...read.values()].some((img) => bounds(img))) return failure(`${layer.name} has nothing in frame ${sources[0]} to run the pipeline on.`);
      const res = runPipeline(p, sources.map((f) => read.get(f)!), info.palette);
      const preview = effectPreview(res.frames, targets.map(String));
      if (apply === "preview") {
        return { content: [...(preview ? [preview] : []), text(`Preview of pipeline ${p.name} on ${layer.name}: ${seconds} (nothing changed).`)] };
      }
      // Stored with its source resolved, so a re-apply finds it (the layer under the effect is hidden by then).
      const json = JSON.stringify({ ...p, source: over ? { layer: layer.name } : { layer: layer.name, frame: anchor } });
      const long = tooLong(json);
      if (long) return long;
      // Insert placement. A re-apply from the same source frame writes over the frames the earlier run inserted
      // (when they are still there) and inserts only the ones it lacks.
      let insert: { after: number; durations: number[] } | undefined, durations: { frame: number; ms: number }[] | undefined, reuseNote = "";
      if (!over) {
        const wasCount = was && typeof was.frames !== "object" ? (was.frames as number | undefined) ?? 8 : 0;
        const reusable = !!old && wasSource?.layer === layer.name && wasSource.frame === anchor && wasCount > 0 && anchor + wasCount <= info.durations.length;
        const reuse = reusable ? Math.min(count, wasCount) : 0;
        const extra = count - (reusable ? wasCount : 0);
        if (extra > 0) insert = { after: anchor + (reusable ? wasCount : 0), durations: Array(extra).fill(ms) };
        if (reuse) durations = Array.from({ length: reuse }, (_, i) => ({ frame: anchor + 1 + i, ms }));
        if (reusable) {
          reuseNote = ` Reused the ${wasCount} frame${wasCount === 1 ? "" : "s"} the earlier run inserted (${anchor + 1}-${anchor + wasCount})` +
            (extra > 0 ? ` and inserted ${extra} more` : extra < 0 ? `; frames ${anchor + count + 1}-${anchor + wasCount} now show ${layer.name} again` : "") + ".";
        }
      }
      const box = bounds(read.get(sources[0])!) ?? { x: 0, y: 0, w: info.width, h: info.height };
      const written = await writeEffect(doc, info, {
        source: layer.id, name: layerName, insert, durations, clear: old ? [old.id] : undefined,
        frames: new Map(targets.map((f, i) => [f, res.frames[i]])),
        palette: res.added.length ? res.added : undefined, label: `Effect pipeline ${p.name}`, prompt: `fx_pipeline ${p.name}`,
        fx: buildRecord({ id, x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2), fps, loop: !!p.loop, windupMs: 0, recipe: json }),
      });
      const where = over ? `ran over frames ${targets.join(", ")}`
        : reuseNote ? `wrote ${count} frames of ${ms} ms after frame ${anchor} (frames ${targets[0]}-${targets.at(-1)})`
        : `inserted ${count} frames of ${ms} ms after frame ${anchor} (frames ${targets[0]}-${targets.at(-1)})`;
      return {
        content: [...(preview ? [preview] : []), text(`Pipeline ${p.name} on ${layer.name}${replaced}: ${where}, on ${written.layer} (${layer.name} hidden under it; ` +
          `${written.frames} frames now)${res.added.length ? `; ${res.added.length} color${res.added.length === 1 ? "" : "s"} added to the palette` : ""}.${reuseNote} ` +
          `FX record ${id}. One undo step.`)],
      };
    },
  },
];

/** `top` copied onto `base` at (x, y), cut to base (transparent pixels skipped). */
function stampAt(base: Rgba, top: Rgba, x: number, y: number) {
  for (let j = 0; j < top.height; j++) for (let i = 0; i < top.width; i++) {
    const X = x + i, Y = y + j;
    if (X < 0 || Y < 0 || X >= base.width || Y >= base.height) continue;
    const s = (j * top.width + i) * 4;
    if (top.data[s + 3]) base.data.set(top.data.subarray(s, s + 4), (Y * base.width + X) * 4);
  }
}
