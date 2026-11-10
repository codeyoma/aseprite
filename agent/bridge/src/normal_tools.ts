// Normal maps and 2D lighting as tools (#47).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import { light, normalMap } from "./normals.js";
import type { Rgba } from "./pixel_grid.js";
import { encodeSnapshot } from "./png.js";
import { frameList, layerPixels, spriteInfo } from "./shading_tools.js";
import type { Tool } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const send = (img: Rgba) => Buffer.from(img.data).toString("base64");

const lightSchema = z.object({
  from: z.enum(["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right", "front"]).optional()
    .describe("Directional light from this side. Default top-left."),
  point: z.object({ x: z.number(), y: z.number(), z: z.number().optional() }).optional().describe("A point light at pixel x, y, z px in front."),
  ambient: z.number().min(0).max(1).optional(),
});
const DIRS: Record<string, [number, number, number]> = {
  "top-left": [-1, 1, 1], top: [0, 1, 1], "top-right": [1, 1, 1], left: [-1, 0, 1], right: [1, 0, 1],
  "bottom-left": [-1, -1, 1], bottom: [0, -1, 1], "bottom-right": [1, -1, 1], front: [0, 0, 1],
};

function writeStrip(path: string, frames: Rgba[]) {
  const w = frames[0].width, h = frames[0].height;
  const png = new PNG({ width: w * frames.length, height: h });
  frames.forEach((f, i) => {
    for (let y = 0; y < h; y++) png.data.set(f.data.subarray(y * w * 4, (y + 1) * w * 4), (y * w * frames.length + i * w) * 4);
  });
  writeFileSync(path, PNG.sync.write(png));
}

export const NORMAL_TOOLS: Tool[] = [
  {
    name: "normal_map",
    title: "Make normal map",
    description:
      "Make a tangent-space normal map for a layer, for engines with 2D lights (Godot, Unity): height from a rounded " +
      "bevel of the silhouette (default), from the colors' lightness, or from a grayscale height layer you drew. " +
      "Normals are quantized for a pixel look (levels). OpenGL convention (green up) by default. Written to a hidden " +
      "'AI: normal <layer>' layer, every frame you choose; paint fixes on it.",
    input: z.object({
      layer: z.string().optional(),
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional().describe("Default: all frames."),
      source: z.enum(["bevel", "luminance", "height"]).optional(),
      height_layer: z.string().optional().describe("For source 'height': a grayscale layer (white = high)."),
      bevel: z.number().min(1).max(64).optional().describe("Bevel width in px."),
      strength: z.number().min(0.1).max(5).optional(),
      levels: z.number().int().min(0).max(8).optional().describe("Tilt steps (0 = smooth). Default 2."),
      convention: z.enum(["opengl", "directx"]).optional(),
    }),
    kind: "edit",
    label: () => "Make normal map",
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const frames = frameList(input.frames ?? "all", info.frames, info.frame);
      for (const f of frames) {
        const img = await layerPixels(aseprite, layer, f);
        const height = input.height_layer ? await layerPixels(aseprite, input.height_layer, f) : undefined;
        const n = normalMap(img, {
          source: input.source ?? (height ? "height" : "bevel"), height, bevel: input.bevel, strength: input.strength,
          levels: input.levels, convention: input.convention,
        });
        await aseprite.request("put_image", { new_layer: `normal ${layer}`, above: layer, hide: true, frame: f, width: n.width, height: n.height, rgba: send(n) });
      }
      return { content: [text(`Made a ${input.convention ?? "opengl"} normal map of ${layer} (${input.source ?? "bevel"}) for ${frames.length} frame(s) on the hidden layer 'AI: normal ${layer}'. Preview it with light_preview.`)] };
    },
  },
  {
    name: "light_preview",
    title: "Preview lighting",
    description: "Render a layer lit through its normal map ('AI: normal <layer>' by default) by a directional or point light, and return the image. Changes nothing.",
    input: z.object({
      layer: z.string().optional(),
      normal_layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      light: lightSchema.optional(),
      convention: z.enum(["opengl", "directx"]).optional(),
    }),
    kind: "read",
    label: () => "Preview lighting",
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const f = input.frame ?? info.frame;
      const albedo = await layerPixels(aseprite, layer, f);
      const normals = await layerPixels(aseprite, input.normal_layer ?? `AI: normal ${layer}`, f);
      const l = input.light ?? {};
      const lit = light(albedo, normals, {
        dir: l.point ? undefined : DIRS[l.from ?? "top-left"],
        point: l.point ? [l.point.x, l.point.y, l.point.z ?? 12] : undefined,
        ambient: l.ambient,
      }, input.convention ?? "opengl");
      const png = encodeSnapshot(Buffer.from(lit.data), lit.width, lit.height, Math.max(1, Math.floor(256 / Math.max(lit.width, lit.height))), "checker");
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, text(`${layer} lit from ${l.point ? `a point at ${l.point.x},${l.point.y}` : l.from ?? "top-left"}.`)] };
    },
  },
  {
    name: "export_normal_sheet",
    title: "Export color and normal sheets",
    description: "Write <name>.png (the layer's frames side by side) and <name>_n.png (its normal map frames, same layout) for an engine's 2D lights.",
    input: z.object({
      layer: z.string().optional(),
      normal_layer: z.string().optional(),
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional().describe("Default: all."),
      dir: z.string(),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Export normal sheet",
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const frames = frameList(input.frames ?? "all", info.frames, info.frame);
      const color: Rgba[] = [], normal: Rgba[] = [];
      for (const f of frames) {
        color.push(await layerPixels(aseprite, layer, f));
        normal.push(await layerPixels(aseprite, input.normal_layer ?? `AI: normal ${layer}`, f));
      }
      const name = input.name ?? layer.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      mkdirSync(input.dir, { recursive: true });
      writeStrip(join(input.dir, `${name}.png`), color);
      writeStrip(join(input.dir, `${name}_n.png`), normal);
      return { content: [text(`Wrote ${name}.png and ${name}_n.png (${frames.length} frames of ${color[0].width}x${color[0].height}, side by side) to ${input.dir}.`)] };
    },
  },
];
