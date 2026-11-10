// Voxels and 2.5D as tools (#45).
import { readFileSync, writeFileSync } from "node:fs";
import * as z from "zod/v4";
import type { Rgba } from "./pixel_grid.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";
import { layersToModel, parseVox, renderIso, rotateModel, writeVox, type VoxelModel } from "./voxels.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });
const DIRS = ["SE", "SW", "NW", "NE"];

/** Renders directions and opens them as one sprite: a frame and tag per direction, bottom-aligned. */
async function openDirections(aseprite: AsepriteRequester, m: VoxelModel, count: 1 | 4, title: string) {
  const imgs: Rgba[] = Array.from({ length: count }, (_, t) => renderIso(rotateModel(m, t)));
  const W = Math.max(...imgs.map((i) => i.width)), H = Math.max(...imgs.map((i) => i.height));
  const frames = imgs.map((im) => {
    const d = new Uint8Array(W * H * 4);
    const ox = Math.floor((W - im.width) / 2), oy = H - im.height;
    for (let y = 0; y < im.height; y++) d.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((oy + y) * W + ox) * 4);
    return { rgba: Buffer.from(d).toString("base64"), duration: 100 };
  });
  const tags = count === 4 ? DIRS.map((n, i) => ({ name: n, from: i + 1, to: i + 1 })) : [];
  const palette = [...new Set(m.voxels.map((v) => v[3]))].map((i) => m.palette[i]).filter(Boolean)
    .map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  const r = await aseprite.request("create_animation", { width: W, height: H, title, frames, tags, palette });
  return { W, H, title: r.result.title as string };
}

export const VOXEL_TOOLS: Tool[] = [
  {
    name: "render_voxels",
    title: "Render voxel model",
    description:
      "Render a MagicaVoxel .vox model as pixel-exact isometric sprites (2:1, each voxel a 4x4 block, three shades per " +
      "material: lit top, mid left, dark right), in 1 or 4 directions (90-degree turns, tagged SE, SW, NW, NE), opened " +
      "as a new sprite with the model's colors as its palette.",
    input: z.object({
      path: z.string().describe("The .vox file."),
      directions: z.union([z.literal(1), z.literal(4)]).optional().describe("Default 4."),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Render voxel model",
    async run(input, aseprite) {
      if (!/\.vox$/i.test(input.path)) return failure("Pass a MagicaVoxel .vox file.");
      const m = parseVox(readFileSync(input.path));
      const r = await openDirections(aseprite, m, (input.directions ?? 4) as 1 | 4, input.name ?? "Voxel model");
      return { content: [text(`Rendered a ${m.sx}x${m.sy}x${m.sz} model (${m.voxels.length} voxels) as "${r.title}": ${input.directions ?? 4} direction(s) of ${r.W}x${r.H}.`)] };
    },
  },
  {
    name: "layers_to_voxels",
    title: "Layers to isometric object",
    description:
      "Build a voxel object from the sprite's layers, bottom layer = the ground slice, each layer one voxel higher " +
      "(top-down drawings: image x is width, image y is depth), and render it in 1 or 4 isometric directions as a new " +
      "sprite. Optionally save it as a .vox for MagicaVoxel.",
    input: z.object({
      frame: z.number().int().min(1).optional(),
      directions: z.union([z.literal(1), z.literal(4)]).optional(),
      save_vox: z.string().optional().describe("Also write a .vox file here."),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Layers to isometric",
    async run(input, aseprite) {
      const { result } = await aseprite.request("execute_lua", {
        code: `local s = app.sprite if not s then error("No active sprite") end local o = {}
          local function walk(ls) for _, l in ipairs(ls) do if l.isGroup then walk(l.layers) elseif l.isImage and l.isVisible then o[#o + 1] = l.name end end end
          walk(s.layers) return { layers = o, frame = app.frame and app.frame.frameNumber or 1 }`,
        transaction: false,
      });
      if (!result.ok) return failure(result.error);
      const names: string[] = result.value.layers;
      if (!names.length) return failure("No visible image layers.");
      const frame = input.frame ?? result.value.frame;
      const imgs: Rgba[] = [];
      for (const n of names) {
        const r = await aseprite.request("snapshot", { layer: n, frame });
        imgs.push({ width: r.result.width, height: r.result.height, data: r.binary! });
      }
      const m = layersToModel(imgs);
      if (!m.voxels.length) return failure("The layers are empty.");
      if (input.save_vox) writeFileSync(input.save_vox, writeVox(m));
      const r = await openDirections(aseprite, m, (input.directions ?? 4) as 1 | 4, input.name ?? "Isometric object");
      return { content: [text(`Stacked ${names.length} layers (${m.voxels.length} voxels) and rendered "${r.title}" in ${input.directions ?? 4} direction(s) of ${r.W}x${r.H}.` +
        (input.save_vox ? ` Saved ${input.save_vox}.` : ""))] };
    },
  },
];
