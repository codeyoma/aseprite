// Sprite sheet import (#41): slice a sheet image into frames and tags.
import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import type { Rgba } from "./pixel_grid.js";
import {
  detectBackground, detectCells, findSprites, frameImages, gridFrames, parseAtlas, removeBackground, tagsFromRows,
  type Align, type Frame, type Tag,
} from "./sheet.js";
import { failure, text, type Tool, type ToolResult } from "./tool.js";


export function readPng(path: string): Rgba {
  if (!/\.png$/i.test(path)) throw new Error("Only PNG sheets can be read");
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: png.data };
}

export const SHEET_TOOLS: Tool[] = [
  {
    name: "import_sheet",
    title: "Import sprite sheet",
    description:
      "Slice a sprite sheet image (e.g. an attachment) into a new animated sprite. Modes: 'auto' finds each sprite " +
      "(connected shapes on a transparent or solid background) in reading order; 'grid' cuts fixed cells (cell size " +
      "given, or found from the empty gutters between sprites); 'atlas' reads an Aseprite or TexturePacker JSON. " +
      "Frames are aligned (bottom-center by default, so characters stand on the same line); rows can become tags.",
    input: z.object({
      path: z.string().describe("The sheet image (PNG)."),
      mode: z.enum(["auto", "grid", "atlas"]).optional().describe("Default: atlas if a .json sits next to the image, else auto."),
      cell_w: z.number().int().min(1).optional(),
      cell_h: z.number().int().min(1).optional(),
      margin_x: z.number().int().min(0).optional(),
      margin_y: z.number().int().min(0).optional(),
      padding_x: z.number().int().min(0).optional().describe("Space between cells."),
      padding_y: z.number().int().min(0).optional(),
      order: z.enum(["rows", "columns"]).optional(),
      atlas: z.string().optional().describe("Atlas JSON path (default: the image path with .json)."),
      merge_distance: z.number().int().min(0).max(32).optional().describe("auto: join shapes this close (px). Default 2."),
      row_tags: z.array(z.string()).optional().describe("Name a tag per row, e.g. ['idle','walk']."),
      align: z.enum(["bottom-center", "center", "top-left"]).optional(),
      duration_ms: z.number().int().min(1).optional().describe("Frame duration when the source has none. Default 100."),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Import sprite sheet",
    async run(input, aseprite) {
      let img = readPng(input.path);
      const atlasPath = input.atlas ?? input.path.replace(/\.png$/i, ".json");
      const mode = input.mode ?? (existsSync(atlasPath) ? "atlas" : "auto");
      const bg = detectBackground(img);
      let frames: Frame[];
      let tags: Tag[] = [];
      let size: { w: number; h: number } | undefined;
      let how: string;
      if (mode === "atlas") {
        const atlas = parseAtlas(JSON.parse(readFileSync(atlasPath, "utf8")));
        frames = atlas.frames;
        tags = atlas.tags;
        size = atlas.width && atlas.height ? { w: atlas.width, h: atlas.height } : undefined;
        how = `atlas ${atlasPath}`;
      } else {
        img = removeBackground(img);
        if (mode === "grid") {
          const found = input.cell_w && input.cell_h ? undefined : detectCells(img);
          const cellW = input.cell_w ?? found?.cellW, cellH = input.cell_h ?? found?.cellH;
          if (!cellW || !cellH) return failure("Couldn't find the cell size from gutters; pass cell_w and cell_h.");
          frames = gridFrames(img, {
            cellW, cellH, marginX: input.margin_x ?? found?.marginX, marginY: input.margin_y ?? found?.marginY,
            paddingX: input.padding_x, paddingY: input.padding_y, order: input.order,
          });
          size = { w: cellW, h: cellH };
          how = `grid of ${cellW}x${cellH} cells${found ? " (found from the gutters)" : ""}`;
        } else {
          frames = findSprites(img, input.merge_distance ?? 2);
          how = "sprites found on the sheet";
        }
        if (input.row_tags?.length || new Set(frames.map((f) => f.row)).size > 1) tags = tagsFromRows(frames, input.row_tags);
      }
      if (!frames.length) return failure("No frames found on the sheet.");
      const align = (input.align ?? "bottom-center") as Align;
      const out = frameImages(img, frames, mode === "grid" ? "top-left" : align, size);
      const { result } = await aseprite.request("create_animation", {
        width: out.width, height: out.height, title: input.name ?? "Imported sheet",
        frames: out.images.map((d, i) => ({ rgba: Buffer.from(d).toString("base64"), duration: frames[i].duration ?? input.duration_ms ?? 100 })),
        tags,
      }, 120_000);
      const bgText = bg.transparent ? "transparent background" : `background ${bg.color!.map((v) => v.toString(16).padStart(2, "0")).join("")} made transparent`;
      return {
        content: [text(`Imported ${frames.length} frames of ${out.width}x${out.height} (${how}; ${bgText}) as "${result.title}"` +
          (tags.length ? `, tags: ${tags.map((t) => `${t.name} ${t.from}-${t.to}`).join(", ")}` : "") + ".")],
      };
    },
  },
];
