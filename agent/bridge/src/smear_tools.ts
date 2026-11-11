// Smear tools (#105): sweep smears, stretch smears, afterimages and multiples made from a layer's motion. The math is
// sprite_fx/smear.ts (centroid motion, block matching, the four looks); the write is sprite_fx/write.ts.
import * as z from "zod/v4";
import { parseHex, type RGBA } from "./color.js";
import { documentOf } from "./document.js";
import type { Rgba } from "./image.js";
import {
  afterimage, blockMotion, colorSet, fieldSpeed, ghostsAlong, motionVector, multiples, SMEAR_MODES, stretch, sweep,
  type MotionField, type SmearFill, type SmearMode,
} from "./sprite_fx/smear.js";
import type { Point } from "./sprite_fx/raster.js";
import { effectPreview, imageLayer, writeEffect } from "./sprite_fx/write.js";
import { framesSpec } from "./tool_inputs.js";
import { failure, text, type Tool } from "./tool.js";

const fmt = (v: Point) => `(${Math.round(v.x)}, ${Math.round(v.y)})`;

export const SMEAR_TOOLS: Tool[] = [
  {
    name: "smear",
    title: "Smear",
    description:
      "Make smears and motion trails from a layer's own motion, in one undo step. Modes: sweep (the frame's shape " +
      "stamped along the way it came, narrower and checker-thinned towards the tail, filled with colors from the art), " +
      "stretch (the frame stretched along the motion, area kept, leading edge in place), afterimage (copies at the " +
      "previous positions, one palette step darker each, checker-dithered), multiples (sharp copies along the path, " +
      "cartoon style). Motion per frame comes from the content's centroid against the previous frame (loop: true lets a " +
      "tag's first frame follow its last); refine: true adds block matching for parts that deform (a swinging arm on a " +
      "still body). Default placement smears, over the frames of `tag`, `frames` or all, only the fast frames (motion " +
      "of at least min_px); `insert_after: N` instead inserts one smear frame between N and N+1. vector gives the " +
      "motion yourself (e.g. one static frame). The result goes on 'AI: smear <layer>' above the layer, which is " +
      "hidden; untouched frames get a copy. Only colors of the art and the sprite palette, no alpha blending. Returns " +
      "a contact sheet of the smeared frames. preview: true shows it without changing the sprite.",
    input: z.object({
      mode: z.enum(SMEAR_MODES as [SmearMode, ...SmearMode[]]),
      layer: z.string().optional().describe("Layer id or name. Default the active layer."),
      tag: z.string().optional().describe("Smear the fast frames of this tag."),
      loop: z.boolean().optional().describe("The tag loops: its first frame's motion is measured from its last frame. Default false (a cycle in place)."),
      frames: framesSpec.optional().describe("Smear the fast frames among these: 3, [1,2], '1-4', 'all'. Default all (or the tag's)."),
      insert_after: z.number().int().min(1).optional().describe("Insert one smear frame between this frame and the next instead."),
      vector: z.object({ x: z.number(), y: z.number() }).optional()
        .describe("The motion in px (where the content goes, +y down), instead of measuring it; for a single static frame."),
      min_px: z.number().min(0).max(256).optional().describe("Smear only frames that move at least this far (over). Default 3."),
      refine: z.boolean().optional().describe("Refine the motion per 4 px block by block matching, for deforming parts. Default false."),
      length: z.number().min(0.1).max(2).optional().describe("Trail length as a share of the motion (sweep). Default 1."),
      taper: z.number().min(0).max(1).optional().describe("How much narrower the tail is (sweep): 0 none, 1 a point. Default 0.5."),
      thin: z.boolean().optional().describe("Checker-thin the far third of the trail (sweep). Default true."),
      fill: z.enum(["ramp", "edge", "source"]).optional()
        .describe("Trail colors (sweep): ramp (the art's 3 main colors, lightest at the head), edge (its outline color), source (each pixel's own). Default ramp."),
      amount: z.number().min(0).max(2).optional().describe("How much of the motion the stretch adds (stretch). Default 1."),
      copies: z.number().int().min(1).max(8).optional().describe("Afterimage ghosts or multiples copies. Default 3."),
      duration_ms: z.number().int().min(10).max(2000).optional().describe("The inserted frame's duration. Default half of frame N's, at most 50."),
      preview: z.boolean().optional().describe("Only show the contact sheet; the sprite does not change."),
    }),
    kind: "edit",
    label: (a) => `Smear: ${a.mode ?? ""}`,
    async run(input, ctx) {
      const doc = documentOf(ctx);
      const info = await doc.info();
      const layer = imageLayer(info, input.layer);
      if (!layer) return failure(`No image layer ${input.layer ?? "is active"}.`);
      const mode = input.mode as SmearMode;
      const n = info.durations.length;
      const copies = input.copies ?? 3, minPx = input.min_px ?? 3;
      if (input.insert_after !== undefined && (input.tag !== undefined || input.frames !== undefined))
        return failure("insert_after inserts one frame; leave out tag and frames.");
      if (input.tag !== undefined && input.frames !== undefined) return failure("Give tag or frames, not both.");

      const read = new Map<number, Rgba>();
      const art = async (f: number) => {
        if (!read.has(f)) read.set(f, await doc.pixels(layer.id, f));
        return read.get(f)!;
      };
      // The frame before f in the motion: in a looping tag the first frame follows the last; else the tag's first frame
      // has no previous one (a dash's last frame jumping back is not motion).
      const tag = input.tag !== undefined ? info.tags.find((t) => t.name === input.tag) : undefined;
      if (input.tag !== undefined && !tag) return failure(`No tag ${input.tag} (tags: ${info.tags.map((t) => t.name).join(", ") || "none"}).`);
      const prevOf = (f: number): number | undefined =>
        tag && f === tag.from ? (input.loop && tag.to > tag.from ? tag.to : undefined) : f > 1 ? f - 1 : undefined;

      const insert = input.insert_after;
      if (insert !== undefined && insert >= n) return failure(`insert_after ${insert} needs a frame after it (the sprite has ${n}).`);
      const targets = insert !== undefined ? [insert + 1]
        : tag ? Array.from({ length: tag.to - tag.from + 1 }, (_, i) => tag.from + i)
        : await doc.frames(input.frames ?? "all");

      // Every color the art uses plus the sprite palette: the afterimages' darker steps come from here.
      const palette = async (): Promise<RGBA[]> => {
        const s = colorSet(...(await Promise.all(targets.map(art))));
        for (const f of targets) { const p = prevOf(f); if (p) for (const c of colorSet(await art(p))) s.add(c); }
        return [...info.palette.map((c) => ({ ...c, a: 255 })), ...[...s].map((h) => parseHex(h)!)];
      };
      let pal: RGBA[] | undefined;

      const made: { frame: number; img: Rgba; v: Point; speed: number }[] = [];
      const slow: string[] = [];
      for (const f of targets) {
        const cur = await art(f);
        const p = prevOf(f);
        const prev = p !== undefined ? await art(p) : undefined;
        const v = input.vector ?? (prev ? motionVector(prev, cur) : undefined);
        if (!v) { slow.push(`${f}: no motion`); continue; }
        let field: MotionField | undefined;
        if (input.refine && prev) field = blockMotion(prev, cur, v);
        const speed = Math.max(Math.hypot(v.x, v.y), field ? fieldSpeed(field) : 0);
        if (insert === undefined ? speed < minPx || speed === 0 : speed < 1) { slow.push(`${f}: ${speed.toFixed(1)} px`); continue; }
        let img: Rgba;
        if (mode === "sweep") {
          img = sweep(cur, v, { length: input.length, taper: input.taper, thin: input.thin, fill: input.fill as SmearFill | undefined, field });
        } else if (mode === "stretch") {
          img = stretch(cur, v, { amount: input.amount });
        } else if (mode === "multiples") {
          img = multiples(cur, v, copies);
        } else {
          // Ghosts: the previous frames' own art, or the frame moved back along a given vector.
          const ghosts: Rgba[] = [];
          if (input.vector || !prev) ghosts.push(...ghostsAlong(cur, v, copies));
          else for (let g = p, k = 0; g !== undefined && g !== f && k < copies; g = prevOf(g), k++) ghosts.push(await art(g));
          pal ??= await palette();
          img = afterimage(cur, ghosts, pal);
        }
        made.push({ frame: insert !== undefined ? insert + 1 : f, img, v, speed });
      }
      if (!made.length) {
        return failure(`Nothing moves fast enough to smear (${slow.join("; ")}). ` +
          (insert !== undefined ? "Give vector, or pick frames whose content moves." : `Lower min_px (now ${minPx}), set refine: true, or give vector.`));
      }

      const preview = effectPreview(made.map((m) => m.img), made.map((m) => String(m.frame)));
      const list = made.map((m) => `${m.frame} ${fmt(m.v)}${Math.abs(m.speed - Math.hypot(m.v.x, m.v.y)) > 0.5 ? ` (fastest part ${m.speed.toFixed(0)} px)` : ""}`).join(", ");
      const skipped = slow.length && insert === undefined ? ` Left as they were: ${slow.join("; ")}.` : "";
      if (input.preview) {
        return { content: [...(preview ? [preview] : []), text(`Preview of ${mode} on ${layer.name}: frames ${list} (nothing changed).${skipped}`)] };
      }
      const ms = input.duration_ms ?? Math.max(10, Math.min(50, Math.round((info.durations[(insert ?? 1) - 1] ?? 100) / 2)));
      const res = await writeEffect(doc, info, {
        source: layer.id, name: `smear ${layer.name}`,
        insert: insert !== undefined ? { after: insert, durations: [ms] } : undefined,
        frames: new Map(made.map((m) => [m.frame, m.img])),
        label: `Smear: ${mode}`, prompt: `smear ${mode}`,
      });
      const where = insert !== undefined ? `inserted a ${ms} ms smear frame after frame ${insert} (frame ${insert + 1}, motion ${fmt(made[0].v)})`
        : `smeared frames ${list}`;
      return {
        content: [
          ...(preview ? [preview] : []),
          text(`${mode} on ${layer.name}: ${where}, on ${res.layer} (${layer.name} hidden under it; ${res.frames} frames now).${skipped} One undo step.`),
        ],
      };
    },
  },
];
