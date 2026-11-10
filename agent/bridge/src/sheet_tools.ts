// Sprite sheet import (#41): slice a sheet image into frames and tags.
import { existsSync, readFileSync } from "node:fs";
import * as z from "zod/v4";
import { documentOf } from "./document.js";
import { readPng } from "./image.js";
import {
  describeBackground, detectBackground, detectCells, findSprites, frameImages, gridFrames, parseAtlasText, removeBackground, tagsFromRows,
  type Align, type Frame, type Tag,
} from "./sheet.js";
import { failure, text, type Tool } from "./tool.js";

/** What import_sheet (and tools reading sheets, templates or font pages) say about a non-PNG path. */
export const NOT_PNG_SHEET = "Only PNG sheets can be read";

export const SHEET_TOOLS: Tool[] = [
  {
    name: "import_sheet",
    title: "Import sprite sheet",
    description:
      "Slice a sprite sheet image (e.g. an attachment) into a new animated sprite. Modes: 'auto' finds each sprite " +
      "(connected shapes on a transparent or solid background) in reading order; 'grid' cuts fixed cells (cell size " +
      "given, or found from the empty gutters between sprites); 'atlas' reads an Aseprite or TexturePacker JSON, a TexturePacker XML (Sparrow/Starling or generic) or a Godot 4 SpriteFrames .tres. " +
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
      atlas: z.string().optional().describe("Atlas path: .json, .xml or .tres (default: one next to the image with the same name)."),
      merge_distance: z.number().int().min(0).max(32).optional().describe("auto: join shapes this close (px). Default 2."),
      row_tags: z.array(z.string()).optional().describe("Name a tag per row, e.g. ['idle','walk']."),
      align: z.enum(["bottom-center", "center", "top-left"]).optional(),
      duration_ms: z.number().int().min(1).optional().describe("Frame duration when the source has none. Default 100."),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Import sprite sheet",
    async run(input, aseprite) {
      let img = readPng(input.path, NOT_PNG_SHEET);
      // An atlas next to the image: .json, .xml or .tres with the same name.
      const atlasPath = input.atlas ?? [".json", ".xml", ".tres"].map((e) => input.path.replace(/\.png$/i, e)).find((p: string) => existsSync(p) && p !== input.path) ?? input.path.replace(/\.png$/i, ".json");
      const mode = input.mode ?? (existsSync(atlasPath) ? "atlas" : "auto");
      const bg = detectBackground(img);
      let frames: Frame[];
      let tags: Tag[] = [];
      let size: { w: number; h: number } | undefined;
      let how: string;
      if (mode === "atlas") {
        const atlas = parseAtlasText(readFileSync(atlasPath, "utf8"), atlasPath);
        frames = atlas.frames;
        tags = atlas.tags;
        size = atlas.width && atlas.height ? { w: atlas.width, h: atlas.height } : undefined;
        how = `atlas ${atlasPath}`;
      } else {
        img = removeBackground(img, undefined, bg);
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
      const result = await documentOf(aseprite).createAnimation(out.width, out.height,
        out.images.map((d, i) => ({ image: { width: out.width, height: out.height, data: d }, duration: frames[i].duration ?? input.duration_ms ?? 100 })),
        { title: input.name ?? "Imported sheet", tags });
      const bgText = bg.transparent ? "transparent background" : `background ${describeBackground(bg)} made transparent`;
      return {
        content: [text(`Imported ${frames.length} frames of ${out.width}x${out.height} (${how}; ${bgText}) as "${result.title}"` +
          (tags.length ? `, tags: ${tags.map((t) => `${t.name} ${t.from}-${t.to}`).join(", ")}` : "") + ".")],
      };
    },
  },
];
