// Dithering and palette swaps as tools (#48).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { hex, parseHex, type RGBA } from "./color.js";
import { applyLut, ditherGradient, ditherToPalette, paletteLut, rampMap, type Pattern } from "./dither.js";
import { documentOf } from "./document.js";
import { framesInput, resolvePalette } from "./tool_inputs.js";
import { recolor, writePng, type Rgba } from "./image.js";
import { failure, text, type Tool } from "./tool.js";

const colorsOf = (list: string[]) => list.map((h) => parseHex(h)).filter((c): c is RGBA => !!c);

const variantSchema = z.object({
  name: z.string(),
  map: z.record(z.string(), z.string()).optional().describe("{'#from': '#to'} for single colors."),
  from: z.array(z.string()).optional().describe("A ramp to replace, dark to light…"),
  to: z.array(z.string()).optional().describe("…with this ramp (steps matched by position)."),
});
type Variant = z.infer<typeof variantSchema>;

function variantMap(v: Variant): Map<string, RGBA> {
  const m = v.from && v.to ? rampMap(colorsOf(v.from), colorsOf(v.to)) : new Map<string, RGBA>();
  for (const [a, b] of Object.entries(v.map ?? {})) {
    const from = parseHex(a), to = parseHex(b);
    if (from && to) m.set(hex(from), to);
  }
  return m;
}

export const DITHER_TOOLS: Tool[] = [
  {
    name: "dither_gradient",
    title: "Dithered gradient",
    description:
      "Fill an area with an ordered-dithered gradient between palette colors (2 or more, e.g. a ramp): only those " +
      "colors appear, mixed with a Bayer 2x2/4x4 or checker pattern. Area: the selection, a rectangle, or the whole " +
      "canvas; with mask_layer, only where that layer has pixels (e.g. a sky shape). Draws on an 'AI: dither' layer.",
    input: z.object({
      colors: z.array(z.string()).min(2),
      direction: z.enum(["horizontal", "vertical", "radial", "diagonal"]).optional().describe("Default vertical."),
      pattern: z.enum(["bayer2", "bayer4", "checker"]).optional().describe("Default bayer4."),
      area: z.union([z.enum(["selection", "canvas"]), z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })]).optional(),
      mask_layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
    }),
    kind: "edit",
    label: () => "Dithered gradient",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const frame = input.frame ?? info.frame;
      const W = info.width, H = info.height;
      let rect = typeof input.area === "object" ? input.area : undefined;
      if (input.area === "selection") {
        rect = info.selection;
        if (!rect) return failure("There is no selection; select an area or pass area: 'canvas'.");
      }
      const mask = input.mask_layer ? await doc.pixels(input.mask_layer, frame) : undefined;
      const img = ditherGradient(W, H, {
        colors: colorsOf(input.colors), direction: input.direction ?? "vertical", pattern: (input.pattern ?? "bayer4") as Pattern, rect, mask,
      });
      await doc.putImage(img, { newLayer: "dither", above: input.mask_layer, frame });
      return { content: [text(`Drew a ${input.direction ?? "vertical"} ${input.pattern ?? "bayer4"} gradient of ${input.colors.length} colors on 'AI: dither'.`)] };
    },
  },
  {
    name: "dither_to_palette",
    title: "Dither to palette",
    description:
      "Convert a layer with smooth shading or gradients (e.g. from a photo or a painted image) to a palette with " +
      "ordered dithering, so gradients become dithered steps instead of flat bands. Palette: 'sprite' (default), a " +
      "known palette name, or hex colors. Result on an 'AI: dithered <layer>' layer, original hidden.",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("the active frame"),
      palette: z.string().optional().describe("'sprite' (default), or a palette name like 'PICO-8'."),
      colors: z.array(z.string()).optional(),
      pattern: z.enum(["bayer2", "bayer4", "checker"]).optional(),
      strength: z.number().min(0).max(1).optional().describe("1 = full dithering; lower keeps more flat areas."),
    }),
    kind: "edit",
    label: () => "Dither to palette",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const palette = input.colors?.length ? colorsOf(input.colors)
        : await resolvePalette(input.palette ?? "sprite", doc);
      if (!palette?.length) return failure(`No palette${input.palette ? ` named ${input.palette}` : ""}.`);
      const frames = await doc.frames(input.frames);
      const imgs = await doc.pixelsMany(layer, frames);
      await doc.putImages(frames.map((f, i) => ({
        image: ditherToPalette(imgs[i], palette, (input.pattern ?? "bayer4") as Pattern, input.strength ?? 1),
        newLayer: `dithered ${layer}`, above: layer, hideSource: true, frame: f,
      })), { label: "Dither to palette" });
      return { content: [text(`Dithered ${layer} to ${palette.length} colors (${input.pattern ?? "bayer4"}) in ${frames.length} frame(s) on 'AI: dithered ${layer}'; the original is hidden.`)] };
    },
  },
  {
    name: "palette_swap",
    title: "Palette swap variants",
    description:
      "Make recolored variants of a layer (team colors, enemy versions, status effects): each variant maps colors " +
      "(single colors with `map`, or a whole ramp `from` -> `to` by position, keeping shading order). Each variant " +
      "goes on its own 'AI: <name>' layer for every frame.",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("all frames"),
      variants: z.array(variantSchema).min(1),
    }),
    kind: "edit",
    label: (a) => `Make ${a.variants?.length ?? ""} palette swaps`.replace("  ", " "),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames ?? "all");
      // One undo step; the variants' new colors join the sprite palette, so check
      // does not flag the swapped pixels as off-palette.
      const maps = input.variants.map((v: Variant) => variantMap(v));
      const items = [];
      for (const f of frames) {
        const img = await doc.pixels(layer, f);
        for (const [i, v] of input.variants.entries()) items.push({ image: recolor(img, maps[i]), frame: f, newLayer: v.name, above: layer });
      }
      const palette: string[] = [...new Set<string>(maps.flatMap((m: Map<string, RGBA>) => [...m.values()].map((c) => hex({ ...c, a: 255 }))))];
      await doc.putImages(items, { palette, label: "Palette swap" });
      return { content: [text(`Made ${input.variants.length} variant(s) of ${layer} over ${frames.length} frame(s): ${input.variants.map((v: Variant) => `'AI: ${v.name}'`).join(", ")}. Show one at a time to compare.`)] };
    },
  },
  {
    name: "export_palette_lut",
    title: "Export palette swap LUT",
    description:
      "Export palette-swap data for a shader: <name>_index.png (each pixel's index into the base palette in the red " +
      "channel) and <name>_lut.png (row 0 the base palette, then one row per variant), plus a Godot shader snippet. " +
      "In the game, color = lut[variant row][index]. Base palette: the sprite's.",
    input: z.object({
      layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      variants: z.array(variantSchema).min(1),
      dir: z.string(),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Export palette LUT",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const img = await doc.pixels(input.layer ?? info.layer, input.frame ?? info.frame);
      const { index, lut, missing } = paletteLut(img, info.palette, input.variants.map((v: Variant) => variantMap(v)));
      // Check: row 0 reproduces the sprite.
      const back = applyLut(index, lut, 0);
      let wrong = 0;
      for (let i = 0; i < back.data.length; i += 4) if (img.data[i + 3] >= 128 && hex({ r: back.data[i], g: back.data[i + 1], b: back.data[i + 2], a: 255 }) !== hex({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 })) wrong++;
      const name = input.name ?? "palette";
      mkdirSync(input.dir, { recursive: true });
      writePng(join(input.dir, `${name}_index.png`), index);
      writePng(join(input.dir, `${name}_lut.png`), lut);
      writeFileSync(join(input.dir, `${name}_swap.gdshader`), `shader_type canvas_item;
// Palette swap: ${name}_index.png as the sprite texture, ${name}_lut.png as lut (filter off).
uniform sampler2D lut : filter_nearest;
uniform int variant = 0; // 0 = base palette
void fragment() {
\tvec4 idx = texture(TEXTURE, UV);
\tfloat i = (idx.r * 255.0 + 0.5) / float(textureSize(lut, 0).x);
\tfloat r = (float(variant) + 0.5) / float(textureSize(lut, 0).y);
\tCOLOR = vec4(texture(lut, vec2(i, r)).rgb, idx.a);
}
`);
      return {
        content: [text(`Wrote ${name}_index.png, ${name}_lut.png (${lut.width} colors x ${lut.height} rows) and ${name}_swap.gdshader to ${input.dir}.` +
          (missing ? ` ${missing} pixels used colors not in the palette and took the nearest one.` : "") +
          (wrong ? ` Warning: ${wrong} pixels don't round-trip.` : " Row 0 reproduces the sprite exactly."))],
      };
    },
  },
];
