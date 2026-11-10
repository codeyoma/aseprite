// Animation helpers as tools (#42): in-betweens for rigid parts along an
// arc, clean rotation, squash and stretch, smear frames. Each writes a
// layer's cels through put_image; no new colors are made.
import * as z from "zod/v4";
import { along, smear, squashStretch, transform, type Easing } from "./animation.js";
import type { Rgba } from "./pixel_grid.js";
import { failure, text, type AsepriteRequester, type Tool, type ToolResult } from "./tool.js";


async function layerPixels(aseprite: AsepriteRequester, layer: string, frame: number): Promise<Rgba> {
  const { result, binary } = await aseprite.request("snapshot", { layer, frame });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

async function write(aseprite: AsepriteRequester, layer: string, frame: number, img: Rgba, label: string) {
  await aseprite.request("put_image", { layer, frame, width: img.width, height: img.height, rgba: Buffer.from(img.data).toString("base64"), label });
}

async function frameCount(aseprite: AsepriteRequester): Promise<number> {
  const { result } = await aseprite.request("execute_lua", { code: "return #app.sprite.frames", transaction: false });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const moveSchema = z.object({
  dx: z.number().optional().describe("Pixels right."),
  dy: z.number().optional().describe("Pixels down."),
  angle: z.number().optional().describe("Degrees clockwise."),
  scale_x: z.number().min(0.1).max(4).optional(),
  scale_y: z.number().min(0.1).max(4).optional(),
  pivot_x: z.number().optional().describe("Rotation/scale pivot in sprite pixels (e.g. a shoulder). Default: canvas center."),
  pivot_y: z.number().optional(),
});

export const ANIMATION_TOOLS: Tool[] = [
  {
    name: "transform_layer",
    title: "In-between a part",
    description:
      "Animate a rigid part (a layer: an arm, a sword, a whole small sprite) from its drawing in from_frame through " +
      "to_frame: each frame gets the drawing moved/rotated/scaled a bit further along `move`, eased, optionally " +
      "along an arc bent upward by `arc` px. Rotation is RotSprite-style, so pixels stay clean and no new colors " +
      "appear. Frames must exist (add them with apply_timeline_text first). Overwrites the layer's cels after from_frame.",
    input: z.object({
      layer: z.string().describe("Layer name."),
      from_frame: z.number().int().min(1),
      to_frame: z.number().int().min(1),
      move: moveSchema.describe("The full change at to_frame."),
      arc: z.number().optional().describe("Bend the path upward by this many pixels at the middle."),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().describe("Default ease-in-out."),
    }),
    kind: "edit",
    label: (a) => (a.layer ? `In-between ${a.layer}` : "In-between"),
    async run(input, aseprite) {
      if (input.to_frame <= input.from_frame) return failure("to_frame must come after from_frame.");
      if (input.to_frame > (await frameCount(aseprite))) return failure("to_frame is past the last frame; add frames first.");
      const base = await layerPixels(aseprite, input.layer, input.from_frame);
      const m = input.move;
      const to = { dx: m.dx, dy: m.dy, angle: m.angle, sx: m.scale_x, sy: m.scale_y, px: m.pivot_x, py: m.pivot_y };
      const n = input.to_frame - input.from_frame;
      for (let f = input.from_frame + 1; f <= input.to_frame; f++) {
        const t = (f - input.from_frame) / n;
        await write(aseprite, input.layer, f, transform(base, along(to, t, input.arc ?? 0, (input.easing ?? "ease-in-out") as Easing)), "In-between");
      }
      return { content: [text(`Animated ${input.layer} over frames ${input.from_frame + 1}-${input.to_frame} (${n} steps, ${input.easing ?? "ease-in-out"}${input.arc ? `, arc ${input.arc}px` : ""}).`)] };
    },
  },
  {
    name: "rotate_layer",
    title: "Rotate cleanly",
    description: "Rotate a layer's drawing in some frames by an angle around a pivot, RotSprite-style (clean edges, no new colors).",
    input: z.object({
      layer: z.string(),
      frames: z.array(z.number().int().min(1)).min(1),
      angle: z.number().describe("Degrees clockwise."),
      pivot_x: z.number().optional(),
      pivot_y: z.number().optional(),
    }),
    kind: "edit",
    label: (a) => `Rotate ${a.layer ?? ""} ${a.angle ?? ""}°`.trim(),
    async run(input, aseprite) {
      for (const f of input.frames) {
        const img = await layerPixels(aseprite, input.layer, f);
        await write(aseprite, input.layer, f, transform(img, { angle: input.angle, px: input.pivot_x, py: input.pivot_y }), "Rotate");
      }
      return { content: [text(`Rotated ${input.layer} by ${input.angle}° in ${input.frames.length} frame(s).`)] };
    },
  },
  {
    name: "squash_stretch",
    title: "Squash and stretch",
    description: "Squash (amount < 0, e.g. -0.2 on landing) or stretch (> 0, e.g. 0.2 on take-off) a layer's drawing in a frame, keeping its area and its feet on the ground.",
    input: z.object({ layer: z.string(), frame: z.number().int().min(1), amount: z.number().min(-0.6).max(0.6) }),
    kind: "edit",
    label: (a) => ((a.amount ?? 0) < 0 ? "Squash" : "Stretch"),
    async run(input, aseprite) {
      const img = await layerPixels(aseprite, input.layer, input.frame);
      await write(aseprite, input.layer, input.frame, squashStretch(img, input.amount), input.amount < 0 ? "Squash" : "Stretch");
      return { content: [text(`${input.amount < 0 ? "Squashed" : "Stretched"} ${input.layer} in frame ${input.frame} by ${Math.abs(input.amount * 100).toFixed(0)}%.`)] };
    },
  },
  {
    name: "smear_frame",
    title: "Smear frame",
    description:
      "Turn a frame into a smear: the layer's drawing at to_frame swept back along the path from from_frame, so a " +
      "fast move (a swing, a dash) reads in one frame. Writes into `frame` (usually between the two).",
    input: z.object({
      layer: z.string(),
      frame: z.number().int().min(1),
      from_frame: z.number().int().min(1),
      to_frame: z.number().int().min(1),
      steps: z.number().int().min(2).max(16).optional(),
    }),
    kind: "edit",
    label: () => "Smear frame",
    async run(input, aseprite) {
      const a = await layerPixels(aseprite, input.layer, input.from_frame);
      const b = await layerPixels(aseprite, input.layer, input.to_frame);
      await write(aseprite, input.layer, input.frame, smear(a, b, input.steps), "Smear");
      return { content: [text(`Frame ${input.frame} of ${input.layer} is now a smear from frame ${input.from_frame} to ${input.to_frame}.`)] };
    },
  },
];
