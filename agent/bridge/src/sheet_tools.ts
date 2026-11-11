// Sprite sheet import (#41): slice a sheet image into frames and tags; an
// animated file (GIF, WebP, APNG, .aseprite) becomes frames as it is.
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import * as z from "zod/v4";
import { asepriteFrames, IMAGE_EXTENSIONS, type FrameDecoder } from "./attachments.js";
import { hex } from "./color.js";
import { documentOf, type Document, type SpriteInfo } from "./document.js";
import { filePalette, readPng } from "./image.js";
import {
  describeBackground, detectBackground, detectCells, findSprites, frameImages, gridFrames, parseAtlasText, removeBackground, tagsFromRows,
  type Align, type Frame, type Tag,
} from "./sheet.js";
import { failure, text, type Tool } from "./tool.js";

/** What import_sheet (and tools reading sheets, templates or font pages) say about a non-PNG path. */
export const NOT_PNG_SHEET = "Only PNG sheets can be read";

/** The decoder import_animation uses; tests swap it. */
export const importDecoder: { decode: FrameDecoder } = { decode: asepriteFrames };


export const SHEET_TOOLS: Tool[] = [
  {
    name: "import_animation",
    title: "Import animation as frames",
    description:
      "Turn an animated image file (GIF, WebP, APNG, .aseprite, FLI; e.g. an attachment's file path) into frames as they are, " +
      "with the file's own frame times. into 'new' (default) opens it as a new sprite with the file's colors as palette; into " +
      "'layer' puts each frame on a new 'AI: <name>' layer of the active sprite, from `frame` on, adding frames at the end " +
      "when needed and setting those frames' durations from the file (timing false keeps the sprite's). Any still image " +
      "Aseprite opens works as one frame. For a sheet of poses in one image, use import_sheet.",
    input: z.object({
      path: z.string().describe("The image file (an attachment's `file` path)."),
      into: z.enum(["new", "layer"]).optional().describe("Default 'new'; 'layer' needs an open sprite."),
      frame: z.number().int().min(1).optional().describe("layer: the first frame to fill. Default 1."),
      name: z.string().optional().describe("The new sprite's title or layer name. Default the file name."),
      timing: z.boolean().optional().describe("layer: set the filled frames' durations from the file. Default true."),
      x: z.number().int().optional().describe("layer: where the file's top-left goes. Default centered on the sprite."),
      y: z.number().int().optional(),
    }),
    kind: "edit",
    label: (i) => (i?.into === "layer" ? "Import animation onto a layer" : "Import animation"),
    async run(input, aseprite) {
      const path = String(input.path);
      if (!IMAGE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) {
        return failure(`Not an image file Aseprite opens (${IMAGE_EXTENSIONS.join(", ")}).`);
      }
      if (!existsSync(path)) return failure(`File not found: ${path}`);
      let decoded;
      try {
        decoded = await importDecoder.decode(path);
      } catch (e) {
        return failure(`Aseprite could not read ${basename(path)}: ${(e as Error).message.split("\n")[0]}`);
      }
      const { frames, durations } = decoded;
      if (!frames.length) return failure("The file has no frames.");
      const { width: w, height: h } = frames[0];
      const name = input.name ?? basename(path, extname(path));
      const n = frames.length;
      const timing = durations.every((d) => d === durations[0]) ? `${durations[0]} ms each` : `durations ${durations.join(", ")} ms`;
      const doc = documentOf(aseprite);
      if ((input.into ?? "new") === "new") {
        const r = await doc.createAnimation(w, h, frames.map((image, i) => ({ image, duration: durations[i] })),
          { title: name, palette: filePalette(frames) });
        return { content: [text(`Opened "${r.title}": ${n} frame${n === 1 ? "" : "s"} of ${w}x${h} (${timing}).`)] };
      }
      const info = await doc.infoOrNone();
      if (!info) return failure("No sprite is open; use into 'new', or open a sprite first.");
      if (info.layers.some((l) => l.name === `AI: ${name}`)) {
        return failure(`The sprite already has a layer 'AI: ${name}'; pass another name.`);
      }
      const start = input.frame ?? 1;
      const x = input.x ?? Math.floor((info.width - w) / 2), y = input.y ?? Math.floor((info.height - h) / 2);
      const last = start + n - 1;
      const r = await doc.putImages(frames.map((image, i) => ({ image, frame: start + i, newLayer: name, x, y })), {
        frames: last, duration: durations[n - 1], label: "Import animation",
        ...(input.timing === false ? {} : { durations: durations.map((ms, i) => ({ frame: start + i, ms })) }),
      });
      const added = r.added ? `, ${r.added} frame${r.added === 1 ? "" : "s"} added` : "";
      const cut = w > info.width || h > info.height ? ` The file is ${w}x${h}, larger than the ${info.width}x${info.height} sprite, so its edges are cut.` : "";
      return {
        content: [text(`Put ${n} frame${n === 1 ? "" : "s"} of ${w}x${h} at ${x},${y} on layer "${r.layers[0]?.name ?? `AI: ${name}`}", ` +
          `frames ${start}-${last}${added}${input.timing === false ? "" : ` (${timing})`}.${cut}`)],
      };
    },
  },
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
