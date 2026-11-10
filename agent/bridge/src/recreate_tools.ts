// Recreate from a reference (#40): turn a screenshot or sprite image the
// user attaches into an editable sprite (native size, palette, frames,
// layers by color role) and describe its style so new art can follow it.
import * as z from "zod/v4";
import { hex, mergeNear, tally } from "./color.js";
import { detectGrid, resample, trim, type Rgba } from "./pixel_grid.js";
import { detectBackground, findSprites, frameImages, removeBackground, tagsFromRows } from "./sheet.js";
import { readPng } from "./sheet_tools.js";
import { analyzeStyle, colorGroups, countColors, type Style } from "./style.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });

export const RIGHTS_NOTE =
  "Recreated art from other games is for study and personal use; publishing it needs the rights holder's permission.";

function applyMap(img: Rgba, map: Map<string, { r: number; g: number; b: number }>) {
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const to = map.get(hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 }));
    if (to) img.data.set([to.r, to.g, to.b], i);
  }
}

function describeStyle(s: Style): string {
  return [
    `Style: ${s.width}x${s.height} px, ${s.colors} colors; outline: ${s.outline.kind === "none" ? "none" : `${s.outline.kind} (${s.outline.colors.join(", ")})`}; ` +
      `ramps: ${s.ramps.map((r) => `${r.name} ${r.steps}`).join(", ") || "none"}; dithering: ${s.dithering > 0.05 ? "yes" : "no"}.`,
    "To draw new art in this style:",
    ...s.rules.map((r) => `- ${r}`),
  ].join("\n");
}

async function snapshotLayer(aseprite: AsepriteRequester, layer?: string, frame?: number): Promise<Rgba> {
  const { result, binary } = await aseprite.request("snapshot", { layer, frame });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

export const RECREATE_TOOLS: Tool[] = [
  {
    name: "recreate_from_reference",
    title: "Recreate from reference",
    description:
      "Rebuild a reference image the user attached (a screenshot or sprite) as an editable sprite: makes the " +
      "background transparent, detects the scale and returns to native pixels, finds the sprites (several poses of " +
      "similar size become frames, rows become tags), sets the palette, splits the layer by color role (outline, " +
      "one layer per color ramp) and describes the style with rules for drawing new art like it. " + RIGHTS_NOTE,
    input: z.object({
      path: z.string().describe("The reference image (PNG)."),
      cell: z.number().min(1).max(64).optional().describe("Scale of the screenshot if detection is wrong (1 = native)."),
      frames: z.enum(["auto", "single"]).optional().describe("'single' keeps everything as one image. Default auto."),
      merge_distance: z.number().int().min(0).max(32).optional(),
      row_tags: z.array(z.string()).optional(),
      split_layers: z.boolean().optional().describe("Split by color role. Default true."),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Recreate from reference",
    async run(input, aseprite) {
      let img = readPng(input.path);
      const bg = detectBackground(img);
      img = removeBackground(img);
      const g = input.cell
        ? { cellX: input.cell, cellY: input.cell, offsetX: 0, offsetY: 0, confidence: 1 }
        : detectGrid(img);
      if (g.cellX > 1) {
        img = resample(img, g);
        const merge = mergeNear(countColors(img));
        applyMap(img, merge);
      }
      let sprites = input.frames === "single" ? [] : findSprites(img, input.merge_distance ?? 2);
      // Poses only when there are several of similar size; otherwise one picture.
      if (sprites.length > 1) {
        const areas = sprites.map((s) => s.rect.w * s.rect.h).sort((a, b) => a - b);
        const median = areas[Math.floor(areas.length / 2)];
        if (sprites.some((s) => s.rect.w * s.rect.h < median * 0.4 || s.rect.w * s.rect.h > median * 2.5)) sprites = [];
      }
      let width: number, height: number, images: Uint8Array[];
      let tags: { name: string; from: number; to: number }[] = [];
      if (sprites.length > 1) {
        const out = frameImages(img, sprites, "bottom-center");
        ({ width, height, images } = out);
        if (new Set(sprites.map((s) => s.row)).size > 1 || input.row_tags?.length) tags = tagsFromRows(sprites, input.row_tags);
      } else {
        const t = trim(img);
        ({ width, height } = t);
        images = [new Uint8Array(t.data)];
      }
      if (!images.length || width < 1) return failure("No opaque pixels left after removing the background.");
      const first: Rgba = { width, height, data: images[0] };
      const palette = tally(images.flatMap((d) => countColors({ width, height, data: d })), 0).map(hex);
      const { result } = await aseprite.request("create_animation", {
        width, height, title: input.name ?? "Recreated", palette, tags,
        frames: images.map((d) => ({ rgba: Buffer.from(d).toString("base64"), duration: 100 })),
      }, 120_000);
      let split = "";
      if (input.split_layers !== false) {
        const groups = colorGroups(first);
        if (groups.length > 1) {
          const r = await aseprite.request("split_layer_by_colors", { groups });
          split = ` Split into layers: ${r.result.layers.join(", ")}.`;
        }
      }
      const style = analyzeStyle(first);
      return {
        content: [text(
          `Recreated "${result.title}": ${images.length} frame${images.length > 1 ? "s" : ""} of ${width}x${height}` +
          `${g.cellX > 1 ? ` (the reference was scaled ${g.cellX}x)` : ""}, ${palette.length} colors as the palette` +
          `${bg.transparent ? "" : ", background removed"}${tags.length ? `, tags ${tags.map((t) => t.name).join(", ")}` : ""}.${split}\n` +
          describeStyle(style) + `\n${RIGHTS_NOTE}`,
        )],
      };
    },
  },
  {
    name: "style_summary",
    title: "Describe style",
    description:
      "How a sprite or a reference image is built: size, colors and ramps (shading steps), outline (one dark color, " +
      "selout, or none), dithering, with rules to follow when drawing new art in that style.",
    input: z.object({
      path: z.string().optional().describe("A reference image (PNG); default: the active sprite."),
      layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
    }),
    kind: "read",
    label: () => "Describe style",
    async run(input, aseprite) {
      let img: Rgba;
      if (input.path) {
        img = removeBackground(readPng(input.path));
        const g = detectGrid(img);
        if (g.cellX > 1) img = resample(img, g);
      } else img = await snapshotLayer(aseprite, input.layer, input.frame);
      const t = trim(img);
      if (t.width < 1 || !countColors(t).length) return failure("No opaque pixels.");
      return { content: [text(describeStyle(analyzeStyle(t)))] };
    },
  },
  {
    name: "split_by_color",
    title: "Split layer by color",
    description:
      "Split a layer into editable layers by color role, across all frames: the outline on one layer and each color " +
      "ramp (by hue) on its own; pixels that fit no group stay on the original layer. One undo step.",
    input: z.object({ layer: z.string().optional().describe("Layer name; default: the active layer.") }),
    kind: "edit",
    label: () => "Split layer by color",
    async run(input, aseprite) {
      const img = await snapshotLayer(aseprite, input.layer);
      const groups = colorGroups(img);
      if (groups.length < 2) return failure("This layer has only one color group; nothing to split.");
      const r = await aseprite.request("split_layer_by_colors", { layer: input.layer, groups });
      return { content: [text(`Split into layers: ${r.result.layers.join(", ")}.`)] };
    },
  },
];
