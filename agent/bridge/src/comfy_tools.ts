// ComfyUI tools (#112): list the user's workflows, run one (a job, since a generation outlasts a tool call), and
// import the poses it made as frames of one animation (pose_import.ts), with landmarks on the clip's keys and part
// layers cut by masks.
import { existsSync, readFileSync } from "node:fs";
import * as z from "zod/v4";
import { describeBundle, httpTransport, listWorkflows, runWorkflow, workflowsDir, comfyUrl, type ComfyTransport, type PoseBundle } from "./comfy.js";
import { documentOf } from "./document.js";
import { hex } from "./color.js";
import { blank, readPng, type Rgba } from "./image.js";
import { ImageJobs, type Job } from "./image_gen.js";
import { MotionStore, defaultContacts, guessParent, kindOf } from "./motion_clip.js";
import { importPoses, parseKeypoints, type Anchor, type PoseIn } from "./pose_import.js";
import { failure, text, type Tool, type ToolContext } from "./tool.js";

let transport: ComfyTransport | undefined;
/** Tests replace the HTTP transport with a fake. */
export function __setComfyTransportForTest(t: ComfyTransport | undefined) { transport = t; }
const comfy = () => transport ?? httpTransport();

// Runs need a job runner; outside the chat (CLI, tests) one is kept here.
const localJobs = new ImageJobs({ generate: () => Promise.reject(new Error("no image generator")) });
const jobsOf = (ctx: ToolContext) => (typeof ctx.images?.startTask === "function" ? ctx.images : localJobs);

/** How long comfy_run waits before handing back a job id. */
export const COMFY_WAIT_MS = 45_000;

async function waitFor(job: Job<PoseBundle>, ms: number): Promise<"done" | "running"> {
  const timeout = new Promise<"running">((r) => setTimeout(() => r("running"), ms).unref?.());
  return Promise.race([job.done.then(() => "done" as const), timeout]);
}

const jobResult = (job: Job<PoseBundle>) => job.error
  ? failure(`ComfyUI job ${job.id} failed: ${job.error}`)
  : { content: [text(describeBundle(job.result!) + "\nImport the poses with poses_to_frames (images: the image files; keypoints: the pose files; masks: per part).")] };

export const COMFY_TOOLS: Tool[] = [
  {
    name: "comfy_workflows",
    title: "ComfyUI workflows",
    description:
      "List the user's ComfyUI workflows the agent may run (#112): each one's name, what it does, its params and its " +
      "outputs by role (image, pose, mask:<part>, depth, frames), from the workflows folder (API-format JSON plus a " +
      ".manifest.json each), and whether ComfyUI answers.",
    input: z.object({}),
    kind: "read",
    label: () => "List ComfyUI workflows",
    async run() {
      const dir = workflowsDir();
      const { workflows, problems } = listWorkflows(dir);
      let status: string;
      try {
        const stats = await comfy().getJson("/system_stats");
        status = `ComfyUI answers at ${comfyUrl()}${stats?.system?.comfyui_version ? ` (${stats.system.comfyui_version})` : ""}.`;
      } catch (e) {
        status = (e as Error).message;
      }
      const lines = workflows.map((w) => `- ${w.name}${w.manifest.description ? `: ${w.manifest.description}` : ""}\n  params: ` +
        Object.entries(w.manifest.params).map(([k, r]) => `${k}${r.image ? " (an image file)" : ""}${r.description ? ` (${r.description})` : ""}`).join(", ") +
        `\n  outputs: ${[...new Set(Object.values(w.manifest.outputs))].join(", ")}`);
      return { content: [text([status, workflows.length ? `Workflows in ${dir}:` : `No workflows in ${dir}. Save one from ComfyUI with "Export (API)" as <name>.json there, beside <name>.manifest.json ({"params": {"prompt": {"node": "6", "input": "text"}}, "outputs": {"9": "image"}}).`,
        ...lines, ...problems.map((p) => `problem: ${p}`)].join("\n"))] };
    },
  },
  {
    name: "comfy_run",
    title: "Run a ComfyUI workflow",
    description:
      "Run one of the user's ComfyUI workflows (#112) with params (a prompt, a seed, a pose image file...) and get its " +
      "files back by role in the session folder: key poses (image), OpenPose keypoints (pose), part masks (mask:<part>), " +
      "depth. It runs as a job: the call waits up to 45 s, then returns a job id; call again with job to wait more. Then " +
      "import the poses with poses_to_frames.",
    input: z.object({
      workflow: z.string().optional().describe("The workflow's name (comfy_workflows)."),
      params: z.record(z.string(), z.unknown()).optional().describe("Its params by name; image params take a file path."),
      job: z.string().optional().describe("Wait for this job instead."),
    }),
    kind: "read",
    label: (a) => (a.job ? "Wait for ComfyUI" : `Run ComfyUI${a.workflow ? `: ${a.workflow}` : ""}`),
    async run(input, ctx) {
      const jobs = jobsOf(ctx);
      if (input.job) {
        const job = jobs.get(input.job) as Job<PoseBundle> | undefined;
        if (!job) return failure(`No job ${input.job}.`);
        if ((await waitFor(job, COMFY_WAIT_MS)) === "running") return { content: [text(`Job ${job.id} is still running; call comfy_run with job "${job.id}" again.`)] };
        return jobResult(job);
      }
      if (!input.workflow) return failure("Give workflow (see comfy_workflows), or job.");
      const w = listWorkflows().workflows.find((x) => x.name === input.workflow);
      if (!w) return failure(`No workflow "${input.workflow}" in ${workflowsDir()} (see comfy_workflows).`);
      if (ctx.ask && !(await ctx.ask("comfyui", `ComfyUI at ${comfyUrl()} to run the workflow "${w.name}"`))) {
        return failure("The user declined ComfyUI. Don't ask for it again in this turn.");
      }
      let job: Job<PoseBundle>;
      try {
        job = jobs.startTask("comfy", w.name, (signal) => runWorkflow(comfy(), w, input.params ?? {}, { signal }), 15 * 60_000);
      } catch (e) {
        return failure((e as Error).message);
      }
      if ((await waitFor(job, COMFY_WAIT_MS)) === "running") return { content: [text(`ComfyUI is running "${w.name}" as job ${job.id}; call comfy_run with job "${job.id}" to wait for it.`)] };
      return jobResult(job);
    },
  },
  {
    name: "poses_to_frames",
    title: "Poses to frames",
    description:
      "Import key poses made elsewhere (ComfyUI: one PNG per pose) as frames of one animation (#112), in one undo step. " +
      "All poses get one treatment, so they don't jitter against each other: one anchor (the hips from OpenPose " +
      "keypoints, else the feet) lines them up, one crop and one pixel grid shrink them at the same scale, one palette " +
      "snaps them. keypoints (OpenPose JSON per pose) become landmarks on the clip's keys; masks (per part, a mask per " +
      "pose) cut each pose into part layers (the poses then go on a hidden reference layer) and give the rig its parts. " +
      "With a tag, the frames become the clip's keys (its keys stage starts).",
    input: z.object({
      images: z.array(z.string()).min(1).max(16).describe("PNG files, one per pose, in order."),
      keypoints: z.array(z.string()).optional().describe("OpenPose JSON files, one per pose (same order)."),
      masks: z.record(z.string(), z.array(z.string())).optional().describe("Part name -> mask PNGs, one per pose (white or opaque where the part is)."),
      frames: z.array(z.number().int().min(1)).optional().describe("The sprite frames to put them on. Default: the clip's keys when they match in number, else 1, 2, ..."),
      tag: z.string().optional().describe("The animation's tag (it must exist): the frames become its clip's keys."),
      size: z.tuple([z.number().int().min(4).max(512), z.number().int().min(4).max(512)]).optional().describe("Canvas [w, h] for a new sprite. Default: the open sprite's."),
      scale: z.number().min(1).max(64).optional().describe("Source pixels per sprite pixel. Default: the poses fit the canvas."),
      anchor: z.enum(["hips", "feet", "source"]).optional().describe("Line the poses up by the hips (keypoints), the feet, or as placed. Default hips when every pose has keypoints, else feet."),
      colors: z.number().int().min(2).max(64).optional().describe("Palette size shared by all poses. Default 16."),
      layer: z.string().optional().describe("The layer for the poses. Default 'Poses' (as 'AI: Poses')."),
      character: z.string().optional().describe("The character the masks' parts make up (its rig). Default 'Character'."),
    }),
    kind: "edit",
    label: (a) => `Import ${a.images?.length ?? ""} poses`.replace("  ", " "),
    async run(input, ctx) {
      const doc = documentOf(ctx);
      const n = input.images.length;
      for (const [what, list] of [["keypoints", input.keypoints], ...Object.entries(input.masks ?? {}).map(([k, v]) => [`masks.${k}`, v])] as [string, string[] | undefined][]) {
        if (list && list.length !== n) return failure(`${what} lists ${list.length} files for ${n} poses.`);
      }
      const missing = [...input.images, ...(input.keypoints ?? []), ...Object.values(input.masks ?? {}).flat()].filter((p) => !existsSync(p));
      if (missing.length) return failure(`No file ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (and ${missing.length - 3} more)` : ""}.`);
      let poses: PoseIn[];
      try {
        poses = input.images.map((p: string, i: number) => {
          const image = readPng(p, `${p}: poses_to_frames reads PNG files (save the workflow's images as PNG).`);
          return {
            image,
            ...(input.keypoints ? { keypoints: parseKeypoints(JSON.parse(readFileSync(input.keypoints[i], "utf8")), image) } : {}),
            ...(input.masks ? { masks: Object.fromEntries(Object.entries(input.masks as Record<string, string[]>).map(([k, v]) => [k, readPng(v[i])])) } : {}),
          };
        });
      } catch (e) {
        return failure((e as Error).message);
      }
      let info = await doc.infoOrNone();
      const [w, h] = input.size ?? (info ? [info.width, info.height] : [64, 64]);
      if (info && (w !== info.width || h !== info.height)) return failure(`The sprite is ${info.width}x${info.height}, not ${w}x${h}: omit size, or open a ${w}x${h} sprite.`);
      let result;
      try {
        result = importPoses(poses, { width: w, height: h, colors: input.colors, scale: input.scale, anchor: input.anchor as Anchor | undefined });
      } catch (e) {
        return failure((e as Error).message);
      }
      let opened = "";
      if (!info) {
        const t = await doc.createAnimation(w, h, Array.from({ length: n }, () => ({ image: blank(w, h) as Rgba, duration: 100 })), { title: input.character ?? "Poses" });
        opened = `Opened "${t.title}" (${w}x${h}, ${n} frames). `;
        info = await doc.info();
      }
      const motion = await MotionStore.load(doc);
      const tag = input.tag ? motion.tag(input.tag) : undefined;
      if (input.tag && !tag) return failure(`No tag "${input.tag}": make the tag and its frames first (apply_timeline_text).`);
      const clipKeys = tag ? motion.view(tag.name)?.keys : undefined;
      const frames: number[] = input.frames ?? (clipKeys?.length === n ? clipKeys : tag && tag.to - tag.from + 1 >= n ? Array.from({ length: n }, (_, i) => tag.from + i) : Array.from({ length: n }, (_, i) => i + 1));
      if (frames.length !== n) return failure(`frames lists ${frames.length} frames for ${n} poses.`);
      if (tag && frames.some((f) => f < tag.from || f > tag.to)) return failure(`The frames must be in "${tag.name}" (${tag.from}-${tag.to}).`);
      const partNames = Object.keys(result.parts);
      const poseLayer = input.layer ?? "Poses";
      const existing = (name: string) => info!.layers.find((l) => !l.group && (l.name === name || l.name === `AI: ${name}`));
      const target = (name: string, hide = false) => {
        const l = existing(name);
        return l ? { layer: l.id } : { newLayer: name, ...(hide ? { hide: true, locked: true } : {}) };
      };
      const items: any[] = result.frames.map((image, i) => ({ image, frame: frames[i], ...target(poseLayer, partNames.length > 0) }));
      for (const name of partNames) result.parts[name].forEach((image, i) => items.push({ image, frame: frames[i], ...target(name) }));
      await doc.putImages(items, { frames: Math.max(...frames), label: `Import ${n} poses`, palette: result.palette.map((c) => hex(c)) });
      // The clip: keys with their landmarks; the rig: the masks' parts.
      const notes = [...result.notes];
      if (partNames.length) {
        const character = input.character ?? "Character";
        const known = motion.rig(character);
        const keep = new Map((known?.parts ?? []).map((p) => [p.layer, p]));
        const layerName = (p: string) => existing(p)?.name ?? `AI: ${p}`;
        const names = partNames.map(layerName);
        motion.setRig(character, { base: frames[0], parts: names.map((l) => keep.get(l) ?? { layer: l, parent: guessParent(l, names) }),
          source: { format: input.keypoints ? "openpose" : "masks", path: input.images[0] } });
      }
      if (tag) {
        const v = motion.view(tag.name);
        const kind = v?.clip.kind ?? kindOf(tag.name);
        const lm = result.landmarks;
        const contacts = v?.clip.contacts ?? defaultContacts(kind, tag.to - tag.from + 1);
        motion.setClip(tag, {
          ...(v?.clip ?? {}), kind, facing: v?.clip.facing ?? "right", loop: v?.clip.loop ?? kind !== "action",
          ...(partNames.length ? { character: input.character ?? "Character" } : {}),
          keys: frames.map((f, i) => ({ at: f - tag.from + 1, ...(Object.keys(lm[i]).length ? { landmarks: lm[i] } : {}) })),
          ...(contacts ? { contacts } : {}),
          stage: "keys",
        });
      }
      await motion.save("Pose import");
      const lm0 = result.landmarks[0];
      return { content: [text([
        `${opened}Put ${n} poses on frames ${frames.join(", ")} at ${result.scale} source px per pixel, lined up by the ${result.anchor}, ` +
          `one ${result.palette.length}-color palette, on "${partNames.length ? `AI: ${poseLayer}" (hidden, locked)` : `AI: ${poseLayer}"`}` +
          (partNames.length ? `; parts cut by their masks: ${partNames.join(", ")}` : "") + ".",
        ...(Object.keys(lm0).length ? [`Landmarks (frame ${frames[0]}): ${Object.entries(lm0).slice(0, 8).map(([k, v]) => `${k} ${v.join(",")}`).join("; ")}${Object.keys(lm0).length > 8 ? "; ..." : ""}`] : []),
        ...(tag ? [`Clip "${tag.name}": these frames are its keys, in the keys stage; check them (walk_check for a walk), then motion_clip advance and inbetween.`] : []),
        ...notes.map((x) => `note: ${x}`),
        "These are drafts: clean the outlines and stray pixels, then snapshot view 'filmstrip'.",
      ].join("\n"))] };
    },
  },
];
