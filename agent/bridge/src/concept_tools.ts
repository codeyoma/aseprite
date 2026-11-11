// Concept-first tools (#79): read a concept sheet or storyboard into a pixel spec, put its panels on a locked
// reference layer (one per frame), store the spec on the sprite, and list where the drawing departs from the
// reference. The measuring is concept.ts; the workflow is the concept skill (agent/skills/concept/SKILL.md).
import * as z from "zod/v4";
import {
  colorName, measure, mismatchRegions, parseSpec, readConcept, silhouetteMatch, specSkeleton, SPEC_MAX,
  type ConceptReading, type FitMethod, type Mismatch, type PanelLayout,
} from "./concept.js";
import { documentOf, resolveFrames, type Document, type SpriteInfo } from "./document.js";
import { blank, readPng } from "./image.js";
import { NOT_PNG_SHEET } from "./sheet_tools.js";
import { failure, text, type Tool } from "./tool.js";
import { framesInput } from "./tool_inputs.js";
import { artWithout, referenceLayer } from "./views.js";

const size = z.union([
  z.tuple([z.number().int().min(1).max(512), z.number().int().min(1).max(512)]),
  z.object({ width: z.number().int().min(1).max(512), height: z.number().int().min(1).max(512) }),
]);
const targetSize = size.optional().describe("The canvas size in pixels, [w, h] or {width, height}. Default: the active sprite's size.");
const panels = z.union([z.literal("auto"), z.object({ cols: z.number().int().min(1).max(64), rows: z.number().int().min(1).max(64) })]).optional()
  .describe("How the image is cut: {cols, rows} of equal panels (as the concept prompt asks), or 'auto' (count the figures per row). Default auto.");
const method = z.enum(["snap", "nearest"]).optional()
  .describe("Scaling to the target: 'snap' takes each pixel's dominant color (as pixel snap), 'nearest' the middle one. Default snap.");

type Size = z.infer<typeof size>;
const sizeOf = (s: Size): [number, number] => (Array.isArray(s) ? s : [s.width, s.height]);

/** The active sprite's info, or undefined when no sprite is open. */

/** The target size: the given one, else the sprite's; throws when there is neither. */
function targetOf(given: Size | undefined, info: SpriteInfo | undefined): [number, number] {
  if (given) return sizeOf(given);
  if (info) return [info.width, info.height];
  throw new Error("No sprite is open: pass target_size, e.g. [32, 32].");
}

const box = (b: number[] | null) => (b ? `${b[0]},${b[1]}-${b[2]},${b[3]}` : "empty");
const pt = (p: number[] | null) => (p ? `${p[0]},${p[1]}` : "-");

/** One line per frame: its panel's silhouette in target pixels. */
function frameLines(r: ConceptReading, frames?: number[]): string[] {
  return r.frames.map((f, i) => `${frames ? `frame ${frames[i]}` : `panel ${i + 1}`}: bounds ${box(f.bounds)}, center ${pt(f.center)}, feet ${pt(f.feet)}` +
    `${f.bounds ? `, ${f.bounds[2] - f.bounds[0] + 1}x${f.bounds[3] - f.bounds[1] + 1} px` : ""}`);
}

const rolesLine = (r: ConceptReading) =>
  r.roles.map((c) => `${c.role} ${c.hex} (${colorName(c.hex)}, ${Math.round(c.share * 100)}%)`).join(", ");

/** The reading of an image path, with the failure text when it can't be read. */
function readImage(path: string, w: number, h: number, layout: PanelLayout | undefined, how: FitMethod | undefined) {
  const img = readPng(path, NOT_PNG_SHEET);
  const reading = readConcept(img, w, h, layout ?? "auto", how ?? "snap");
  return { img, reading };
}

/** A frames input as the frames to fill, one per panel: a first frame (number), a list, a range or 'all'. */
function panelFrames(spec: unknown, n: number, count: number): number[] {
  if (spec === undefined) return Array.from({ length: n }, (_, i) => i + 1);
  if (typeof spec === "number") return Array.from({ length: n }, (_, i) => spec + i);
  if (String(spec) === "all") return Array.from({ length: n }, (_, i) => i + 1);
  const list = resolveFrames(spec, Math.max(count, 9999), 1);
  if (list.length !== n) throw new Error(`frames lists ${list.length} frames for ${n} panels; give one per panel or the first frame.`);
  return list;
}

export const CONCEPT_TOOLS: Tool[] = [
  {
    name: "concept_spec",
    title: "Read concept into a pixel spec",
    description:
      "Read a concept sheet or storyboard image (e.g. one the user generated from the concept skill's prompt and attached) " +
      "into a pixel spec skeleton (JSON) for a target canvas: removes the background, cuts the panels, scales each to the " +
      "target and measures its silhouette in target pixels (bounds [x0,y0,x1,y1], center, top, feet), and maps the dominant " +
      "colors to guessed roles (outline, main, highlight, shadow, accent). Poses, eyes, hands, a weapon tip and deliberate " +
      "deviations are left empty for you to fill in after looking at the image; then store it with pixel_spec. Changes nothing.",
    input: z.object({
      image: z.string().describe("The concept image (PNG), e.g. an attachment's path."),
      target_size: targetSize,
      panels,
      method,
    }),
    kind: "read",
    label: () => "Read concept into a pixel spec",
    async run(input, aseprite) {
      const info = await documentOf(aseprite).infoOrNone();
      let w: number, h: number, img, reading: ConceptReading;
      try {
        [w, h] = targetOf(input.target_size, info);
        ({ img, reading } = readImage(input.image, w, h, input.panels, input.method));
      } catch (e) {
        return failure((e as Error).message);
      }
      const s = reading.storyboard;
      const spec = specSkeleton(reading, { path: input.image, width: w, height: h, imageSize: [img.width, img.height] });
      const empty = reading.frames.filter((f) => !f.bounds).length;
      return {
        content: [text(
          `${input.image}: ${img.width}x${img.height}, ${s.panels.length} panel${s.panels.length === 1 ? "" : "s"} (${s.cols}x${s.rows} grid of ` +
          `${s.panels[0].w}x${s.panels[0].h}), background ${s.background}. Measured at ${w}x${h}:\n${frameLines(reading).join("\n")}\n` +
          `Colors: ${rolesLine(reading)}.\n` +
          (empty ? `${empty} panel(s) came out empty: check the panel grid.\n` : "") +
          "Pixel spec skeleton below. Look at the image, fill in pose per frame, the eyes, hands and weapon_tip landmarks " +
          "(target pixels, null when not visible), correct the color roles and map them onto the sprite palette, and list " +
          "deviations (what you simplify or drop on purpose at this size). Then store it with pixel_spec.\n" +
          "```json\n" + JSON.stringify(spec, null, 1) + "\n```",
        )],
      };
    },
  },
  {
    name: "pixel_spec",
    title: "Pixel spec",
    description:
      "Store the pixel spec (the JSON written from a concept: canvas, frames with bounds and landmarks, palette roles, " +
      "deviations) on the sprite, so later steps and review can read it; without spec, return the stored one. The " +
      "spec lives in the sprite (saved with the .aseprite file). One undo step.",
    input: z.object({
      spec: z.union([z.string(), z.record(z.string(), z.unknown())]).optional()
        .describe("The pixel spec as a JSON object or JSON text. Omit to read the stored spec; '' removes it."),
    }),
    kind: "edit",
    label: (a) => (a.spec === undefined ? "Read pixel spec" : "Store pixel spec"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      if (input.spec === undefined) {
        const stored = (await doc.info()).pixelSpec;
        return { content: [text(stored ? `Stored pixel spec:\n\`\`\`json\n${stored}\n\`\`\`` : "No pixel spec is stored on this sprite.")] };
      }
      let json = "";
      if (input.spec !== "") {
        try {
          json = JSON.stringify(parseSpec(input.spec));
        } catch (e) {
          return failure((e as Error).message);
        }
        if (json.length > SPEC_MAX) return failure(`The pixel spec is ${json.length} characters; at most ${SPEC_MAX} fit on a sprite.`);
      }
      await doc.putImages([], { spec: json, label: "Pixel spec" });
      return { content: [text(json ? `Stored the pixel spec on the sprite (${json.length} characters).` : "Removed the pixel spec.")] };
    },
  },
  {
    name: "storyboard_to_frames",
    title: "Storyboard to reference frames",
    description:
      "Put a storyboard's panels on the sprite's frames as a locked reference layer: the background is removed, panel i is " +
      "scaled to the canvas (snap or nearest) and goes on frame i of a new 'AI: Reference' layer, hidden (or faint), locked " +
      "so it can't be painted on; missing frames are added. One undo step. The active layer stays the active one, so " +
      "draw on your own layer, then compare with snapshot view 'compare' and mismatch_regions. Opens a sprite of " +
      "target_size first when none is open. Also stores the pixel spec (the one given, else the measured skeleton when " +
      "the sprite has none). The panels are a guide to trace proportions and placement, not the art.",
    input: z.object({
      image: z.string().describe("The storyboard image (PNG), e.g. an attachment's path."),
      panels,
      target_size: targetSize,
      frames: z.union([z.number().int().min(1), z.string(), z.array(z.number().int().min(1))]).optional()
        .describe("Where the panels go: the first frame (a number) or one frame per panel ([1,2,3,4], '5-8'). Default frames 1..N."),
      method,
      show: z.enum(["hidden", "faint"]).optional()
        .describe("'hidden' (default) keeps the reference out of snapshots and export; 'faint' shows it at 25% opacity to trace over."),
      name: z.string().optional().describe("Layer name after 'AI: '. Default 'Reference'."),
      spec: z.union([z.string(), z.record(z.string(), z.unknown())]).optional()
        .describe("A pixel spec to store in the same step (JSON object or text)."),
    }),
    kind: "edit",
    label: () => "Storyboard to reference frames",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      let info = await doc.infoOrNone();
      let w: number, h: number, img, reading: ConceptReading, frames: number[];
      const name = input.name ?? "Reference";
      let spec: string | undefined;
      try {
        [w, h] = targetOf(input.target_size, info);
        if (info && (w !== info.width || h !== info.height)) {
          throw new Error(`The sprite is ${info.width}x${info.height}; omit target_size or open a ${w}x${h} sprite first.`);
        }
        ({ img, reading } = readImage(input.image, w, h, input.panels, input.method));
        frames = panelFrames(input.frames, reading.images.length, info?.durations.length ?? reading.images.length);
        if (info?.layers.some((l) => l.name === `AI: ${name}`)) {
          throw new Error(`The sprite already has a layer 'AI: ${name}'; delete it first or pass another name.`);
        }
        if (input.spec !== undefined) spec = JSON.stringify(parseSpec(input.spec));
        else if (!info?.pixelSpec) spec = JSON.stringify(specSkeleton(reading, { path: input.image, width: w, height: h, imageSize: [img.width, img.height] }));
        if (spec && spec.length > SPEC_MAX) throw new Error(`The pixel spec is ${spec.length} characters; at most ${SPEC_MAX} fit on a sprite.`);
      } catch (e) {
        return failure((e as Error).message);
      }
      const need = Math.max(...frames);
      let opened = "";
      if (!info) {
        // No sprite: a blank one with a frame per panel, its one layer left for the art.
        const r = await doc.createAnimation(w, h, Array.from({ length: need }, () => ({ image: blank(w, h), duration: 100 })), { title: "Storyboard" });
        opened = `Opened "${r.title}" (${w}x${h}, ${need} frames). `;
        info = await doc.info();
      }
      const faint = input.show === "faint";
      const r = await doc.putImages(reading.images.map((image, i) => ({
        image, frame: frames[i], newLayer: name, locked: true, ...(faint ? { opacity: 64 } : { hide: true }),
      })), { frames: need, label: "Storyboard to reference frames", ...(spec !== undefined ? { spec } : {}) });
      const s = reading.storyboard;
      const empty = reading.frames.filter((f) => !f.bounds).length;
      const art = info.layer && info.layer !== `AI: ${name}` ? `"${info.layer}"` : "a layer of your own";
      return {
        content: [text(
          `${opened}Put ${s.panels.length} panel${s.panels.length === 1 ? "" : "s"} (${s.cols}x${s.rows} grid, background ${s.background}) on frames ` +
          `${frames.join(", ")} of '${r.layers[0]?.name ?? `AI: ${name}`}', ${faint ? "faint (25%)" : "hidden"} and locked; ` +
          `${r.added ? `added ${r.added} frame${r.added === 1 ? "" : "s"}, ` : ""}one undo step.\nReference silhouettes:\n${frameLines(reading, frames).join("\n")}\n` +
          `Colors: ${rolesLine(reading)}.\n` +
          (empty ? `${empty} panel(s) came out empty: check the panel grid.\n` : "") +
          (spec !== undefined ? `Stored the ${input.spec !== undefined ? "given" : "measured"} pixel spec on the sprite (pixel_spec reads it).\n` : "") +
          `Draw each frame on ${art} (not the reference), then snapshot view 'compare' and mismatch_regions; fix the 3-5 largest mismatches.`,
        )],
      };
    },
  },
  {
    name: "mismatch_regions",
    title: "Mismatches with the reference",
    description:
      "Where the drawing departs from the reference layer, largest first: the silhouettes (alpha >= 128) are compared per " +
      "frame, and each connected area that only the reference covers ('missing': add art there) or only the art covers " +
      "('extra': remove or move it) is listed with its frame, bounds [x0,y0,x1,y1] and size, plus per frame the overlap " +
      "(IoU) and how far the art's center is from the reference's. Fix the top few, then run it again. Changes nothing.",
    input: z.object({
      reference: z.string().optional().describe("The reference layer (name or id). Default: a layer named like 'reference'."),
      layer: z.string().optional().describe("The art layer (name or id). Default: every shown image layer but the reference."),
      frames: framesInput("every frame where the reference has a cel"),
      top: z.number().int().min(1).max(50).optional().describe("How many regions to list. Default 5."),
    }),
    kind: "read",
    label: () => "Find mismatches with the reference",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      let ref, frames: number[];
      try {
        ref = referenceLayer(info, input.reference);
        frames = resolveFrames(input.frames ?? "all", info.durations.length, info.frame, "all");
      } catch (e) {
        return failure((e as Error).message);
      }
      const all: Mismatch[] = [];
      const lines: string[] = [];
      for (const f of frames) {
        const refImage = await doc.pixels(ref.id, f);
        if (!measure(refImage).bounds) {
          if (input.frames !== undefined) lines.push(`frame ${f}: the reference is empty`);
          continue;
        }
        const art = await artWithout(doc, info, ref, input.layer, f);
        const s = silhouetteMatch(refImage, art);
        all.push(...mismatchRegions(refImage, art, f));
        lines.push(`frame ${f}: overlap ${Math.round(s.iou * 100)}%, ` + (s.art.center
          ? `art center ${pt(s.art.center)} vs reference ${pt(s.ref.center)} (dx ${s.dx}, dy ${s.dy})`
          : "no art yet"));
      }
      if (!lines.length) return failure(`The reference layer "${ref.name}" has no art on frames ${frames.join(", ")}.`);
      const top = all.sort((a, b) => b.pixels - a.pixels || a.frame - b.frame).slice(0, input.top ?? 5);
      const list = top.map((m, i) => `${i + 1}. frame ${m.frame}, ${m.kind} ${m.pixels} px at ${box(m.bounds)} ` +
        `(${m.bounds[2] - m.bounds[0] + 1}x${m.bounds[3] - m.bounds[1] + 1}): ${m.kind === "missing" ? "the reference has shape here, the art doesn't" : "art where the reference has none"}`);
      return {
        content: [text(
          `Reference "${ref.name}" vs ${input.layer ? `layer "${input.layer}"` : "the art"}, by silhouette:\n${lines.join("\n")}\n` +
          (top.length ? `Largest mismatches (${all.length} in all):\n${list.join("\n")}` : "No mismatches: the silhouettes match.") +
          "\nA mismatch you made on purpose belongs in the pixel spec's deviations.",
        )],
      };
    },
  },
];
