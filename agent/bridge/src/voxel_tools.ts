// Voxels and 2.5D as tools (#45).
import { readFileSync, writeFileSync } from "node:fs";
import * as z from "zod/v4";
import { documentOf, type Document } from "./document.js";
import type { Rgba } from "./image.js";
import { failure, text, type Tool } from "./tool.js";
import { layersToModel, parseVox, renderIso, rotateModel, writeVox, type VoxelModel } from "./voxels.js";

const DIRS = ["SE", "SW", "NW", "NE"];

/** Renders directions and opens them as one sprite: a frame and tag per direction, bottom-aligned. */
async function openDirections(doc: Document, m: VoxelModel, count: 1 | 4, title: string) {
  const imgs: Rgba[] = Array.from({ length: count }, (_, t) => renderIso(rotateModel(m, t)));
  const W = Math.max(...imgs.map((i) => i.width)), H = Math.max(...imgs.map((i) => i.height));
  const frames = imgs.map((im) => {
    const d = new Uint8Array(W * H * 4);
    const ox = Math.floor((W - im.width) / 2), oy = H - im.height;
    for (let y = 0; y < im.height; y++) d.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((oy + y) * W + ox) * 4);
    return { image: { width: W, height: H, data: d }, duration: 100 };
  });
  const tags = count === 4 ? DIRS.map((n, i) => ({ name: n, from: i + 1, to: i + 1 })) : [];
  const palette = [...new Set(m.voxels.map((v) => v[3]))].map((i) => m.palette[i]).filter(Boolean)
    .map((c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  const r = await doc.createAnimation(W, H, frames, { title, tags, palette });
  return { W, H, title: r.title };
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
      const r = await openDirections(documentOf(aseprite), m, (input.directions ?? 4) as 1 | 4, input.name ?? "Voxel model");
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
      const doc = documentOf(aseprite);
      const info = await doc.info();
      // Bottom layer first: it is the ground slice.
      const layers = info.layers.filter((l) => !l.group && l.visible).reverse();
      if (!layers.length) return failure("No visible image layers.");
      const frame = input.frame ?? info.frame;
      const imgs: Rgba[] = [];
      for (const l of layers) imgs.push(await doc.pixels(l.id, frame));
      const m = layersToModel(imgs);
      if (!m.voxels.length) return failure("The layers are empty.");
      if (input.save_vox) writeFileSync(input.save_vox, writeVox(m));
      const r = await openDirections(doc, m, (input.directions ?? 4) as 1 | 4, input.name ?? "Isometric object");
      return { content: [text(`Stacked ${layers.length} layers (${m.voxels.length} voxels) and rendered "${r.title}" in ${input.directions ?? 4} direction(s) of ${r.W}x${r.H}.` +
        (input.save_vox ? ` Saved ${input.save_vox}.` : ""))] };
    },
  },
];
