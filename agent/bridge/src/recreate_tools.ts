// Recreate from a reference (#40): turn a screenshot or sprite image the
// user attaches into an editable sprite (native size, palette, frames,
// layers by color role) and describe its style so new art can follow it.
import * as z from "zod/v4";
import { hex, mergeNear, tally } from "./color.js";
import { documentOf, type Document } from "./document.js";
import { filePalette, readPng, recolor, trim, writePng, type Rgba } from "./image.js";
import { detectGrid, resample } from "./pixel_grid.js";
import { imageSource, readSource, sourceKind, type ImageSource } from "./tool_inputs.js";
import {
  describeBackground, detectBackground, findSprites, frameImages, removeBackground, similarSized, tagsFromRows, type Frame, type Tag,
} from "./sheet.js";
import { NOT_PNG_SHEET } from "./sheet_tools.js";
import { analyzeStyle, colorGroups, countColors, type Style } from "./style.js";
import { failure, text, type Tool } from "./tool.js";


export const RIGHTS_NOTE =
  "Recreated art from other games is for study and personal use; publishing it needs the rights holder's permission.";

/** Sprites cut out as same-size frames, bottom-aligned; several rows (or row names) become tags. */
function poseFrames(img: Rgba, sprites: Frame[], rowTags?: string[]): { width: number; height: number; images: Uint8Array[]; tags: Tag[] } {
  const { width, height, images } = frameImages(img, sprites, "bottom-center");
  const tags = new Set(sprites.map((s) => s.row)).size > 1 || rowTags?.length ? tagsFromRows(sprites, rowTags) : [];
  return { width, height, images, tags };
}

/** A new animated sprite from same-size images, with their colors as its palette (when 256 or fewer). */
async function openAnimation(doc: Document, width: number, height: number, images: Uint8Array[], title: string, tags: Tag[]) {
  const palette = filePalette(images.map((d) => ({ width, height, data: d })), Infinity)!;
  const result = await doc.createAnimation(width, height, images.map((d) => ({ image: { width, height, data: d }, duration: 100 })),
    { title, palette: palette.length <= 256 ? palette : undefined, tags });
  return { title: result.title, palette };
}

/** Whether a source reads a PNG file. */
const isFile = (src: ImageSource) => sourceKind(src) === "file";

/** Sprite boxes as "x,y wxh", one line per row. */
function listSprites(sprites: Frame[], max = 100): string {
  const lines: string[] = [];
  sprites.slice(0, max).forEach((s, i) => {
    const box = `${i + 1}: ${s.rect.x},${s.rect.y} ${s.rect.w}x${s.rect.h}`;
    if (i > 0 && sprites[i - 1].row === s.row) lines[lines.length - 1] += `; ${box}`;
    else lines.push(`row ${(s.row ?? 0) + 1}: ${box}`);
  });
  if (sprites.length > max) lines.push(`... and ${sprites.length - max} more`);
  return lines.join("\n");
}

function describeStyle(s: Style): string {
  return [
    `Style: ${s.width}x${s.height} px, ${s.colors} colors; outline: ${s.outline.kind === "none" ? "none" : `${s.outline.kind} (${s.outline.colors.join(", ")})`}; ` +
      `ramps: ${s.ramps.map((r) => `${r.name} ${r.steps}`).join(", ") || "none"}; dithering: ${s.dithering > 0.05 ? "yes" : "no"}.`,
    "To draw new art in this style:",
    ...s.rules.map((r) => `- ${r}`),
  ].join("\n");
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
      let img = readPng(input.path, NOT_PNG_SHEET);
      const bg = detectBackground(img);
      img = removeBackground(img, undefined, bg);
      const g = input.cell
        ? { cellX: input.cell, cellY: input.cell, offsetX: 0, offsetY: 0, confidence: 1 }
        : detectGrid(img);
      if (g.cellX > 1) {
        img = resample(img, g);
        img = recolor(img, mergeNear(countColors(img)));
      }
      let sprites = input.frames === "single" ? [] : findSprites(img, input.merge_distance ?? 2);
      // Poses only when there are several of similar size; otherwise one picture.
      if (!similarSized(sprites)) sprites = [];
      let width: number, height: number, images: Uint8Array[];
      let tags: Tag[] = [];
      if (sprites.length > 1) ({ width, height, images, tags } = poseFrames(img, sprites, input.row_tags));
      else {
        const t = trim(img);
        ({ width, height } = t);
        images = [new Uint8Array(t.data)];
      }
      if (!images.length || width < 1) return failure("No opaque pixels left after removing the background.");
      const first: Rgba = { width, height, data: images[0] };
      const doc = documentOf(aseprite);
      const result = await openAnimation(doc, width, height, images, input.name ?? "Recreated", tags);
      const palette = result.palette;
      let split = "";
      if (input.split_layers !== false) {
        const groups = colorGroups(first);
        if (groups.length > 1) {
          const r = await doc.splitByColors(groups);
          split = ` Split into layers: ${r.layers.join(", ")}.`;
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
        img = removeBackground(readPng(input.path, NOT_PNG_SHEET));
        const g = detectGrid(img);
        if (g.cellX > 1) img = resample(img, g);
      } else img = await documentOf(aseprite).pixels(input.layer, input.frame);
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
      const doc = documentOf(aseprite);
      const img = await doc.pixels(input.layer);
      const groups = colorGroups(img);
      if (groups.length < 2) return failure("This layer has only one color group; nothing to split.");
      const r = await doc.splitByColors(groups, { layer: input.layer });
      return { content: [text(`Split into layers: ${r.layers.join(", ")}.`)] };
    },
  },
  {
    name: "detect_background",
    title: "Detect background",
    description:
      "Find the background of an image (a PNG such as an attachment, the sprite, or a layer) from its border: " +
      "transparent, one key color, or a checkerboard (a screenshot of a transparent image), and how much of the " +
      "image it covers. With remove, makes it transparent: a PNG is written to out; a sprite or layer goes onto a " +
      "new 'AI: no background' layer above it (the original layer is hidden). Only remove changes anything.",
    input: imageSource.extend({
      remove: z.boolean().optional().describe("Make the background transparent. Default false: only report it."),
      tolerance: z.number().int().min(0).max(64).optional().describe("Per-channel difference still counted as background. Default 8."),
      out: z.string().optional().describe("With remove on a PNG: where to write the result. Default: next to it, '-nobg'."),
    }),
    kind: "edit",
    label: (a) => (a.remove ? "Remove background" : "Detect background"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const read = await readSource(input, doc);
      const img = read.image;
      const bg = detectBackground(img);
      const clean = removeBackground(img, input.tolerance ?? 8, bg);
      const total = img.width * img.height;
      let n = 0;
      for (let i = 3; i < clean.data.length; i += 4) if (clean.data[i] < 128) n++;
      let msg = `${img.width}x${img.height} image: the background is ${describeBackground(bg)}` +
        `${bg.checker ? " (a screenshot of a transparent image)" : ""}, ${Math.round((n / total) * 100)}% of the pixels.`;
      if (!input.remove) return { content: [text(msg)] };
      if (bg.transparent) return { content: [text(`${msg} Nothing to remove.`)] };
      if (isFile(input)) {
        const out = input.out ?? input.path!.replace(/(\.png)?$/i, "-nobg.png");
        writePng(out, clean);
        msg += ` Wrote it with a transparent background to ${out}.`;
      } else {
        const info = await doc.info();
        const visible = info.layers.filter((l) => l.visible && !l.group);
        const kind = sourceKind(input);
        const source = kind === "layer" ? input.layer : kind === "sprite" && visible.length === 1 ? visible[0].id : undefined;
        // A selection's part goes back at its place; the layer under it stays shown.
        const r = await doc.putImage(clean, { newLayer: "no background", above: source, hideSource: !!source, frame: read.frame ?? input.frame, x: read.x, y: read.y, label: "Remove background" });
        msg += ` Put it with a transparent background on '${r.name}'${source ? " (the original is hidden)" : ""}.`;
      }
      return { content: [text(msg)] };
    },
  },
  {
    name: "find_sprites",
    title: "Find sprites",
    description:
      "Find the separate sprites in an image (a PNG such as a screenshot or a loose sheet, the sprite, or a layer): " +
      "removes the background (key color, checkerboard or transparent), then lists each connected shape's box " +
      "(x,y wxh, in reading order by row); shapes closer than merge_distance join (a sword apart from the hand). " +
      "as 'frames' cuts them into a new animated sprite, one frame each, bottom-aligned (rows become tags); as " +
      "'layers' puts each on its own 'AI: <name> <n>' layer at its place in the current sprite. Boxes are in the " +
      "image's pixels: for an upscaled screenshot, use fix_pixel_art or recreate_from_reference to get native pixels.",
    input: imageSource.extend({
      merge_distance: z.number().int().min(0).max(32).optional().describe("Join shapes this close (px). Default 2."),
      min_pixels: z.number().int().min(1).optional().describe("Drop specks smaller than this many pixels. Default 4."),
      as: z.enum(["list", "frames", "layers"]).optional().describe("'list' (default) only reports the boxes."),
      row_tags: z.array(z.string()).optional().describe("as 'frames': a tag name per row, e.g. ['idle','walk']."),
      name: z.string().optional().describe("Title of the new sprite (frames) or layer name prefix (layers, default 'sprite')."),
    }),
    kind: "edit",
    label: (a) => (a.as === "frames" ? "Cut sprites into frames" : a.as === "layers" ? "Cut sprites onto layers" : "Find sprites"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const read = await readSource(input, doc);
      const img = read.image;
      const bg = detectBackground(img);
      const clean = removeBackground(img, undefined, bg);
      const sprites = findSprites(clean, input.merge_distance ?? 2, input.min_pixels ?? 4);
      if (!sprites.length) return failure(`No sprites found on the ${describeBackground(bg)} background.`);
      const rows = new Set(sprites.map((s) => s.row)).size;
      const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
      let msg = `${plural(sprites.length, "sprite")} in ${plural(rows, "row")} on a ${describeBackground(bg)} background` +
        `${similarSized(sprites) ? " (similar sizes: they fit as frames of one animation)" : ""}:\n${listSprites(sprites)}`;
      if (input.as === "frames") {
        const f = poseFrames(clean, sprites, input.row_tags);
        const r = await openAnimation(doc, f.width, f.height, f.images, input.name ?? "Sprites", f.tags);
        msg += `\nOpened "${r.title}": ${plural(f.images.length, "frame")} of ${f.width}x${f.height}, bottom-aligned` +
          `${f.tags.length ? `, tags ${f.tags.map((t) => `${t.name} ${t.from}-${t.to}`).join(", ")}` : ""}.`;
      } else if (input.as === "layers") {
        const base = input.name ?? "sprite";
        const names: string[] = [];
        for (const [i, s] of sprites.entries()) {
          const cut = frameImages(clean, [s], "top-left");
          const r = await doc.putImage({ width: cut.width, height: cut.height, data: cut.images[0] },
            { newLayer: `${base} ${i + 1}`, x: s.rect.x + read.x, y: s.rect.y + read.y, frame: read.frame ?? input.frame, label: "Cut sprites onto layers" });
          names.push(r.name);
        }
        msg += `\nCut onto ${plural(names.length, "layer")}: ${names.length > 4 ? `${names[0]} ... ${names.at(-1)}` : names.join(", ")}.`;
      }
      return { content: [text(msg)] };
    },
  },
];
