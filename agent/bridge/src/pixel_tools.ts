// Pixel snap tools (#37): detect the pixel grid of upscaled or AI-made
// pixel art and rebuild it as a native-size sprite.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import { hex, kMeans, mergeNear, tally, type Counted } from "./color.js";
import { detectGrid, resample, trim, type Grid, type Rgba } from "./pixel_grid.js";
import { encodeSnapshot } from "./png.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });

const sourceSchema = z.object({
  source: z.enum(["file", "sprite", "layer"]).optional().describe("Default 'file' when a path is given, else 'sprite'."),
  path: z.string().optional().describe("Image file (PNG), e.g. an attachment."),
  layer: z.string().optional().describe("Layer name for source 'layer'."),
  frame: z.number().int().min(1).optional().describe("Frame for sprite/layer. Default: active."),
});
type Source = z.infer<typeof sourceSchema>;

async function readPixels(src: Source, aseprite: AsepriteRequester): Promise<Rgba> {
  if (src.path && src.source !== "sprite" && src.source !== "layer") {
    if (!/\.png$/i.test(src.path)) throw new Error("Only PNG files can be read; attach the image as PNG");
    const png = PNG.sync.read(readFileSync(src.path));
    return { width: png.width, height: png.height, data: png.data };
  }
  const { result, binary } = await aseprite.request("snapshot", { frame: src.frame, layer: src.source === "layer" ? src.layer : undefined });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

function describe(g: Grid): string {
  if (g.cellX <= 1 && g.cellY <= 1) return "no grid: this already looks like native-resolution pixel art (or a photo)";
  const cell = g.cellX === g.cellY ? `${g.cellX}` : `${g.cellX}x${g.cellY}`;
  return `cells of ${cell} px starting at (${g.offsetX}, ${g.offsetY}), confidence ${(g.confidence * 100).toFixed(0)}%`;
}

function countColors(img: Rgba): Counted[] {
  const counts = new Map<string, Counted>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const c = { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 };
    const k = hex(c);
    const e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { ...c, count: 1 });
  }
  return [...counts.values()];
}

/** Recolors an RGBA image in place with a hex -> color map. */
function applyMap(img: Rgba, map: Map<string, { r: number; g: number; b: number }>): void {
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const to = map.get(hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 }));
    if (to) {
      img.data[i] = to.r;
      img.data[i + 1] = to.g;
      img.data[i + 2] = to.b;
    }
  }
}

export const PIXEL_TOOLS: Tool[] = [
  {
    name: "detect_pixel_grid",
    title: "Detect pixel grid",
    description:
      "Find the pixel grid of upscaled or AI-generated pixel art (an image file such as an attachment, or the " +
      "sprite): the cell size in pixels (fractional when the scale is odd, e.g. 5.5) and where the grid starts. " +
      "Cell 1 means the image is already native pixel art.",
    input: sourceSchema,
    kind: "read",
    label: () => "Detect pixel grid",
    async run(input, aseprite) {
      const img = await readPixels(input, aseprite);
      const g = detectGrid(img);
      const size = g.cellX > 1 ? ` -> about ${Math.round(img.width / g.cellX)}x${Math.round(img.height / g.cellY)} px at native size` : "";
      return { content: [text(`${img.width}x${img.height} image: ${describe(g)}${size}.`)] };
    },
  },
  {
    name: "fix_pixel_art",
    title: "Fix pixel art",
    description:
      "Turn upscaled or AI-generated pixel art into a real sprite at its native size: detect the grid (or use " +
      "cell/offset), take one color per cell (the cell's dominant color, not a blend), make alpha fully on or off, " +
      "merge colors that differ only by noise, optionally reduce to max_colors, and trim empty borders. Opens the " +
      "result as a new sprite and returns a preview.",
    input: sourceSchema.extend({
      cell: z.number().min(1).max(128).optional().describe("Cell size if detection is wrong."),
      offset_x: z.number().min(0).optional(),
      offset_y: z.number().min(0).optional(),
      max_colors: z.number().int().min(2).max(256).optional().describe("Reduce to this many colors (k-means)."),
      merge: z.boolean().optional().describe("Merge near-identical colors. Default true."),
      trim: z.boolean().optional().describe("Trim transparent borders. Default true."),
      name: z.string().optional().describe("Title of the new sprite."),
    }),
    kind: "edit",
    label: () => "Fix pixel art",
    async run(input, aseprite) {
      const img = await readPixels(input, aseprite);
      let g = detectGrid(img);
      if (input.cell) g = { cellX: input.cell, cellY: input.cell, offsetX: input.offset_x ?? 0, offsetY: input.offset_y ?? 0, confidence: 1 };
      if (g.cellX <= 1 && g.cellY <= 1) {
        return failure(`${img.width}x${img.height}: ${describe(g)}. Nothing to fix; if it is scaled anyway, pass cell.`);
      }
      let out: Rgba = resample(img, g);
      const before = countColors(out).length;
      if (input.merge !== false) applyMap(out, mergeNear(countColors(out)));
      if (input.max_colors && countColors(out).length > input.max_colors) {
        const centers = kMeans(tally(countColors(out), 0), input.max_colors);
        const map = new Map<string, { r: number; g: number; b: number }>();
        for (const c of countColors(out)) {
          let best = centers[0], bd = Infinity;
          for (const k of centers) {
            const d = (k.r - c.r) ** 2 + (k.g - c.g) ** 2 + (k.b - c.b) ** 2;
            if (d < bd) { bd = d; best = k; }
          }
          map.set(hex(c), best);
        }
        applyMap(out, map);
      }
      if (input.trim !== false) out = trim(out);
      const colors = tally(countColors(out), 0);
      const { result } = await aseprite.request("create_sprite", {
        width: out.width, height: out.height, rgba: Buffer.from(out.data).toString("base64"),
        title: input.name ?? "Fixed pixel art", palette: colors.map(hex),
      });
      const preview = encodeSnapshot(Buffer.from(out.data), out.width, out.height, Math.max(1, Math.floor(256 / Math.max(out.width, out.height))), "checker");
      return {
        content: [
          { type: "image", data: preview.toString("base64"), mimeType: "image/png" },
          text(`${img.width}x${img.height} -> ${out.width}x${out.height} (${describe(g)}). ${before} colors after resampling, ` +
            `${colors.length} after cleanup. Opened as a new sprite "${result.title}" with these colors as its palette.`),
        ],
      };
    },
  },
];
