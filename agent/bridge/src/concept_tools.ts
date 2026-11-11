// Concept-first tools (#79): read a concept sheet or storyboard into a pixel spec, put its panels on a locked
// reference layer (one per frame), store the spec on the sprite, and list where the drawing departs from the
// reference. The measuring is concept.ts; the workflow is the concept skill (agent/skills/concept/SKILL.md).
import * as z from "zod/v4";
import {
  colorName, measure, mismatchRegions, parseSpec, readConcept, silhouetteMatch, specSkeleton, SPEC_MAX,
  type ConceptReading, type FitMethod, type Mismatch, type PanelLayout,
} from "./concept.js";
import { documentOf, resolveFrames, type Document, type SpriteInfo } from "./document.js";
import { blank, countColors, encodePng, flatten, readPng, scale, shrink, snapToPalette, writePng, type Rgba } from "./image.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quantize } from "./color.js";
import type { Aspect, Job } from "./image_gen.js";
import { DEFAULT_LAYERS, alignToMaster, generateLayered, gridFor, shifted, type LayeredResult, type PartLayer } from "./layered.js";
import { hex } from "./color.js";
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
/** Each panel reduced to `colors` colors (k-means over all panels together), for a draft to clean up (#102). */
export function pixelDrafts(images: Rgba[], colors: number): Rgba[] {
  const all = images.flatMap((img) => countColors(img));
  const palette = quantize(all, colors);
  return images.map((img) => snapToPalette(img, palette));
}

/** A generate_image result: the image (path, size, a small preview), the error, or the job still running. */
function imageResult(id: string, finished: boolean, job: { started: number; result?: { path: string; width: number; height: number }; error?: string }) {
  if (!finished) {
    const s = Math.round((Date.now() - job.started) / 1000);
    return { content: [text(`Still generating (${s}s so far). Call generate_image with job "${id}" to keep waiting.`)] };
  }
  if (job.error) return failure(`The image generator failed: ${job.error} Draw it yourself instead.`);
  const r = job.result!;
  const preview = shrink(readPng(r.path), 256);
  return {
    content: [
      text(`Generated ${r.path} (${r.width}x${r.height}). It is a rough design to trace, not pixel art: put it on the sprite with ` +
        `storyboard_to_frames (image: that path, draft: 8-16 for a pixel draft), then clean the draft up and compare.`),
      { type: "image" as const, data: encodePng(preview).toString("base64"), mimeType: "image/png" },
    ],
  };
}

/** What a layered job needs to put its result on the sprite (#103). */
interface LayeredMeta {
  subject: string;
  poses: string[];
  frames?: number[];
  size?: [number, number];
  layers: PartLayer[];
  colors: number;
  character: string;
  tag?: string;
}

/** A layer panel more than this share outside the master's silhouette, after the shift, is misaligned. */
const MISALIGNED = 0.35;

/**
 * Puts a finished layered result on the sprite in one write: the master panels on a hidden, locked reference layer,
 * each part layer's panels snapped to one palette (from the master) and shifted into the master's silhouette, then
 * groups the parts under "AI: <character>" and stores the walk limbs (and the motion stage for a tag).
 */
async function applyLayered(ctx: any, r: LayeredResult, m: LayeredMeta): Promise<string> {
  const doc = documentOf(ctx);
  let info = await doc.infoOrNone();
  const [w, h] = m.size ?? (info ? [info.width, info.height] : [32, 32]);
  if (info && (w !== info.width || h !== info.height)) throw new Error(`The sprite is ${info.width}x${info.height}, not ${w}x${h}: open a ${w}x${h} sprite or omit target_size.`);
  const g = gridFor(m.poses.length);
  const layout = { cols: g.cols, rows: g.rows };
  const read = (path: string) => readConcept(readPng(path), w, h, layout, "snap").images.slice(0, m.poses.length);
  const masterPanels = read(r.master.path);
  const palette = quantize(masterPanels.flatMap((img) => countColors(img)), m.colors);
  const frames = m.frames ?? m.poses.map((_, i) => i + 1);
  const need = Math.max(...frames);
  let opened = "";
  if (!info) {
    const t = await doc.createAnimation(w, h, Array.from({ length: need }, () => ({ image: blank(w, h), duration: 100 })), { title: m.character });
    opened = `Opened "${t.title}" (${w}x${h}, ${need} frames). `;
    info = await doc.info();
  }
  const taken = new Set(info.layers.map((l) => l.name));
  const refName = taken.has("AI: Reference") ? `${m.character} reference` : "Reference";
  const items: any[] = masterPanels.map((image, i) => ({ image: snapToPalette(image, palette), frame: frames[i], newLayer: refName, locked: true, hide: true }));
  const notes: string[] = [];
  const placed: string[] = [];
  let below = `AI: ${refName}`;
  for (const l of r.layers) {
    if (!l.image) { notes.push(`- ${l.name}: not generated (${l.error ?? "no image"}); draw it on a layer "${l.name}" in the group from the reference.`); continue; }
    let panels: Rgba[];
    try { panels = read(l.image.path); } catch (e) { notes.push(`- ${l.name}: unreadable (${(e as Error).message}); draw it from the reference.`); continue; }
    const shifts: string[] = [];
    let worst = 0;
    panels.forEach((p, i) => {
      const snapped = snapToPalette(p, palette);
      const a = alignToMaster(snapped, masterPanels[i]);
      worst = Math.max(worst, a.pixels ? a.outside : 0);
      if (a.dx || a.dy) shifts.push(`pose ${i + 1} moved ${a.dx},${a.dy}`);
      if (a.pixels) items.push({ image: shifted(snapped, a.dx, a.dy), frame: frames[i], newLayer: l.name, above: below });
    });
    if (!panels.some((p) => countColors(p).length)) { notes.push(`- ${l.name}: the image came back empty; draw it from the reference.`); continue; }
    below = `AI: ${l.name}`;
    placed.push(l.name);
    notes.push(`- ${l.name}: ${shifts.length ? shifts.join(", ") : "in place"}` +
      (worst > MISALIGNED ? `; ${Math.round(worst * 100)}% falls outside the master's silhouette: compare it with the reference and redraw what is off` : ""));
  }
  await doc.putImages(items, { frames: need, label: `Layered ${m.character}`, palette: palette.map((c) => hex(c)) });
  // Group the parts, bottom to top, under "AI: <character>", named by part.
  const group = `AI: ${m.character}`;
  await ctx.request("execute_lua", { code: [
    "local s = app.sprite",
    "local function find(name) for _, l in ipairs(s.layers) do if l.name == name then return l end end end",
    `local g = s:newGroup(); g.name = ${JSON.stringify(group)}`,
    `for _, n in ipairs(${luaList(placed)}) do local l = find("AI: " .. n); if l then l.parent = g; l.name = n end end`,
    "return true",
  ].join("\n") });
  // walk_check's limbs, and the motion stage for a tag.
  info = await doc.info();
  let spec: Record<string, any> = {};
  try { spec = info.pixelSpec ? JSON.parse(info.pixelSpec) : {}; } catch { spec = {}; }
  if (placed.includes("near arm") && placed.includes("near leg")) {
    spec.walk = { ...(spec.walk ?? {}), nearArm: { layer: "near arm" }, nearLeg: { layer: "near leg" } };
  }
  let stage = "";
  const tag = m.tag ? info.tags.find((t) => t.name.toLowerCase() === m.tag!.toLowerCase()) : undefined;
  if (tag && frames.length > 1) {
    spec.motion = { tag: tag.name, keys: frames, stage: "keys", walk: /walk|run/i.test(tag.name) };
    spec.walk = { ...spec.walk, tag: tag.name, contacts: spec.walk?.contacts };
    stage = ` Motion stage "keys" for "${tag.name}" (keys ${frames.join(", ")}): walk_check, then motion_stage advance for the in-betweens.`;
  }
  await doc.putImages([], { spec: JSON.stringify(spec), label: "Layered character spec" });
  return `${opened}Put "${m.character}" on the sprite: the master in a hidden, locked "AI: ${refName}", and ${placed.length} part ` +
    `layer${placed.length === 1 ? "" : "s"} in the group "${group}" (bottom to top: ${placed.join(", ")}) on frames ${frames.join(", ")}, ` +
    `with one ${palette.length}-color palette.${stage}\n${notes.join("\n")}\n` +
    "These are drafts at the target size: clean each part (outline, ramps, stray pixels), keep the joints joined, then snapshot.";
}

const luaList = (xs: string[]) => `{ ${xs.map((x) => JSON.stringify(x)).join(", ")} }`;

/** How long one generate_image call waits for its job before handing back the job id. */
export const IMAGE_WAIT_MS = 45_000;

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
    name: "generate_character",
    title: "Generate a layered character",
    description:
      "A new character as body-part layers from the image generator (#103): first a master sheet with the whole " +
      "character in every key pose, then one image per layer (default 8: far arm, far leg, torso, near leg, head, eyes, " +
      "hair, near arm) drawn from the master, each with that part in every pose. The user is asked once for the whole " +
      "batch. It takes several minutes: while it says it is still generating, call again with the job id. When done, " +
      "the parts land in a group 'AI: <name>' on the key frames, aligned to the master (hidden 'AI: Reference'), with " +
      "one palette, walk_check's limbs and, with a tag, the motion stage. For items and props use generate_image.",
    input: z.object({
      subject: z.string().min(1).max(1500).optional().describe("The character and its style, in English (from the user's request)."),
      view: z.string().optional().describe("Default 'side view, facing right'."),
      poses: z.array(z.string()).min(1).max(9).optional()
        .describe("One line per key pose in frame order (a walk: contact, passing, contact, passing). A still sprite: one pose."),
      frames: z.array(z.number().int().min(1)).optional().describe("The sprite frame of each pose. Default: the motion stage's keys, else 1..N."),
      tag: z.string().optional().describe("The animation's tag: its motion stage starts at keys."),
      target_size: targetSize,
      layers: z.array(z.object({ name: z.string(), part: z.string() })).min(1).max(16).optional()
        .describe("The part layers, bottom to top, each with how to tell the image model which part it is. Default the 8 rough layers; finer only when the user asks."),
      colors: z.number().int().min(4).max(64).optional().describe("Palette size. Default 16."),
      name: z.string().optional().describe("The character's name for the group. Default 'Character'."),
      reference: z.boolean().optional().describe("Attach a snapshot of the sprite's current frame 1, so the master keeps an existing character's design. Default: true when the sprite already has art."),
      job: z.string().optional().describe("Wait for this job instead of starting one."),
    }),
    kind: "edit",
    label: (a) => (a.job ? `Waiting for character ${a.job}` : "Generate a layered character"),
    async run(input, ctx) {
      const jobs = ctx.images;
      if (!jobs || !ctx.ask) return failure("The image generator works only in the chat panel's own agent. Draw it yourself.");
      const finish = async (job: Job<LayeredResult>) => {
        if (!(await jobs.wait(job, IMAGE_WAIT_MS))) {
          const s = Math.round((Date.now() - job.started) / 1000);
          return { content: [text(`Still generating (${job.progress ?? "starting"}, ${s}s so far). Call generate_character with job "${job.id}" to keep waiting.`)] };
        }
        if (job.error) return failure(`The layered generation failed: ${job.error} Draw it yourself, or try generate_image for one draft.`);
        if (job.applied) return { content: [text(`Job ${job.id} is already on the sprite.`)] };
        job.applied = true;
        try {
          return { content: [text(await applyLayered(ctx, job.result!, job.meta as LayeredMeta))] };
        } catch (e) {
          job.applied = false;
          return failure((e as Error).message);
        }
      };
      if (input.job) {
        const job = jobs.get(input.job);
        if (!job || job.kind !== "layered") return failure(`No layered job ${input.job}.`);
        return finish(job);
      }
      if (!input.subject || !input.poses) return failure("Give subject and poses (or a job id to wait for).");
      const running = jobs.running();
      if (running) return failure(`Another generation (${running.id}) is running; wait for it first.`);
      const layers: PartLayer[] = input.layers ?? DEFAULT_LAYERS;
      let frames = input.frames;
      if (!frames) {
        const info = await documentOf(ctx).infoOrNone();
        let motion: any;
        try { motion = info?.pixelSpec ? JSON.parse(info.pixelSpec).motion : undefined; } catch { motion = undefined; }
        if (motion?.keys?.length === input.poses.length) frames = motion.keys;
      }
      if (frames && frames.length !== input.poses.length) return failure(`frames lists ${frames.length} frames for ${input.poses.length} poses.`);
      const count = layers.length + 1;
      const ok = await ctx.ask("image_generator",
        `the image generator for ${count} images (1 master sheet + ${layers.length} layers: ${layers.map((l) => l.name).join(", ")}; ` +
        `Codex image generation, it uses your Codex plan's limits, several minutes) to make a layered character: ` +
        (input.subject.length > 200 ? input.subject.slice(0, 200) + "..." : input.subject));
      if (!ok) return failure("The user declined the image generator. Draw the character yourself, and don't ask for it again in this turn.");
      const meta: LayeredMeta = {
        subject: input.subject, poses: input.poses, frames, layers, colors: input.colors ?? 16,
        character: input.name ?? "Character", tag: input.tag,
        size: input.target_size ? (Array.isArray(input.target_size) ? input.target_size : [input.target_size.width, input.target_size.height]) as [number, number] : undefined,
      };
      // An existing character: its frame 1, enlarged on white, goes along with the master's prompt.
      let reference: string | undefined;
      const info = await documentOf(ctx).infoOrNone();
      if (info && input.reference !== false) {
        const px = await documentOf(ctx).pixels(undefined, 1);
        let opaque = 0;
        for (let i = 3; i < px.data.length; i += 4) if (px.data[i] >= 128) opaque++;
        if (opaque) {
          const s = Math.max(1, Math.floor(512 / Math.max(px.width, px.height)));
          reference = join(mkdtempSync(join(tmpdir(), "aseprite-ref-")), "character.png");
          writePng(reference, scale(flatten(px, { r: 255, g: 255, b: 255, a: 255 }), s));
        }
      }
      let job: Job<LayeredResult>;
      try {
        job = jobs.startTask<LayeredResult>("layered", input.subject, (signal, j) => generateLayered(jobs.generator,
          { subject: input.subject!, view: input.view ?? "Side view, facing right", poses: input.poses!, reference }, layers, signal, 3,
          (done, total) => { j.progress = `${done} of ${total} images`; }), 25 * 60_000, meta);
      } catch (e) {
        return failure((e as Error).message);
      }
      return finish(job);
    },
  },
  {
    name: "generate_image",
    title: "Generate an image",
    description:
      "Make a rough image from a prompt with the image generator (Codex's image generation, on the user's Codex plan), " +
      "for a concept sheet or storyboard to trace: then storyboard_to_frames with its path (draft: N for a pixel draft). " +
      "The user is asked first; if they decline, draw it yourself and don't call this again in this turn. A generation " +
      "takes a minute or two: when the result says it is still running, call again with its job id to keep waiting. " +
      "Only for new designs with no reference; never to copy an existing character or artwork.",
    input: z.object({
      prompt: z.string().min(1).max(4000).optional().describe("The image prompt (English): subject, view, layout, plain background, no text."),
      aspect: z.enum(["square", "portrait", "landscape"]).optional().describe("Default square; landscape for a storyboard row."),
      job: z.string().optional().describe("Wait for this job (from an earlier call) instead of starting one."),
      cancel: z.boolean().optional().describe("With job: cancel it."),
    }),
    kind: "read",
    label: (input) => (input.job ? `Waiting for image ${input.job}` : "Generate an image"),
    async run(input, ctx) {
      const jobs = ctx.images;
      if (!jobs || !ctx.ask) return failure("The image generator works only in the chat panel's own agent. Draw it yourself.");
      if (input.job) {
        const job = jobs.get(input.job);
        if (!job) return failure(`No image job ${input.job}.`);
        if (input.cancel) return { content: [text(jobs.cancel(input.job) ? `Cancelled ${input.job}.` : `${input.job} already finished.`)] };
        return imageResult(job.id, await jobs.wait(job, IMAGE_WAIT_MS), job);
      }
      if (!input.prompt) return failure("Give a prompt (or a job id to wait for).");
      const running = jobs.running();
      if (running) return imageResult(running.id, await jobs.wait(running, IMAGE_WAIT_MS), running);
      const short = input.prompt.length > 300 ? input.prompt.slice(0, 300) + "..." : input.prompt;
      const ok = await ctx.ask("image_generator",
        `the image generator (Codex image generation; it uses your Codex plan's limits) to make a rough image for: ${short}`);
      if (!ok) return failure("The user declined the image generator. Draw it yourself, and don't ask for it again in this turn.");
      let job;
      try {
        job = jobs.start(input.prompt, (input.aspect ?? "square") as Aspect);
      } catch (e) {
        return failure((e as Error).message);
      }
      return imageResult(job.id, await jobs.wait(job, IMAGE_WAIT_MS), job);
    },
  },
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
      draft: z.number().int().min(2).max(64).optional()
        .describe("Also put a pixel draft on a visible 'AI: Draft' layer: each panel as the reference has it, reduced to this many " +
          "colors. A starting point to clean up (outline, ramps, stray pixels), not finished art."),
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
      const drafts = input.draft ? pixelDrafts(reading.images, input.draft) : [];
      const r = await doc.putImages([
        ...reading.images.map((image, i) => ({
          image, frame: frames[i], newLayer: name, locked: true, ...(faint ? { opacity: 64 } : { hide: true }),
        })),
        ...drafts.map((image, i) => ({ image, frame: frames[i], newLayer: "Draft", above: `AI: ${name}` })),
      ], { frames: need, label: "Storyboard to reference frames", ...(spec !== undefined ? { spec } : {}) });
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
          (drafts.length ? `Put a ${input.draft}-color pixel draft on 'AI: Draft' (visible, editable): clean it up there (outline, ramps, stray pixels, readable shapes at 1x).\n` : "") +
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
