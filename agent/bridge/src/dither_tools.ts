// Dithering and palette swaps as tools (#48).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import { hex, parseHex, type RGBA } from "./color.js";
import { applyLut, applyMap, ditherGradient, ditherToPalette, paletteLut, rampMap, type Pattern } from "./dither.js";
import { findPalette } from "./palettes.js";
import type { Rgba } from "./pixel_grid.js";
import { frameList, layerPixels, spriteInfo } from "./shading_tools.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });
const send = (img: Rgba) => Buffer.from(img.data).toString("base64");
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

function writePng(path: string, img: Rgba) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(path, PNG.sync.write(png));
}

async function selectionRect(aseprite: AsepriteRequester): Promise<{ x: number; y: number; w: number; h: number } | undefined> {
  const { result } = await aseprite.request("execute_lua", {
    code: "local s = app.sprite.selection if s.isEmpty then return nil end local b = s.bounds return { x = b.x, y = b.y, w = b.width, h = b.height }",
    transaction: false,
  });
  return result.ok ? result.value ?? undefined : undefined;
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
      const info = await spriteInfo(aseprite);
      const frame = input.frame ?? info.frame;
      const { result: dims } = await aseprite.request("execute_lua", { code: "return { w = app.sprite.width, h = app.sprite.height }", transaction: false });
      const W = dims.value.w, H = dims.value.h;
      let rect = typeof input.area === "object" ? input.area : undefined;
      if (input.area === "selection") {
        rect = await selectionRect(aseprite);
        if (!rect) return failure("There is no selection; select an area or pass area: 'canvas'.");
      }
      const mask = input.mask_layer ? await layerPixels(aseprite, input.mask_layer, frame) : undefined;
      const img = ditherGradient(W, H, {
        colors: colorsOf(input.colors), direction: input.direction ?? "vertical", pattern: (input.pattern ?? "bayer4") as Pattern, rect, mask,
      });
      await aseprite.request("put_image", { new_layer: "dither", above: input.mask_layer, frame, width: W, height: H, rgba: send(img) });
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
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional(),
      palette: z.string().optional(),
      colors: z.array(z.string()).optional(),
      pattern: z.enum(["bayer2", "bayer4", "checker"]).optional(),
      strength: z.number().min(0).max(1).optional().describe("1 = full dithering; lower keeps more flat areas."),
    }),
    kind: "edit",
    label: () => "Dither to palette",
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const palette = input.colors?.length ? colorsOf(input.colors)
        : input.palette && input.palette !== "sprite" ? findPalette(input.palette)?.colors : info.palette;
      if (!palette?.length) return failure(`No palette${input.palette ? ` named ${input.palette}` : ""}.`);
      const frames = frameList(input.frames, info.frames, info.frame);
      for (const f of frames) {
        const out = ditherToPalette(await layerPixels(aseprite, layer, f), palette, (input.pattern ?? "bayer4") as Pattern, input.strength ?? 1);
        await aseprite.request("put_image", { new_layer: `dithered ${layer}`, above: layer, hide_source: true, frame: f, width: out.width, height: out.height, rgba: send(out) });
      }
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
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional().describe("Default: all frames."),
      variants: z.array(variantSchema).min(1),
    }),
    kind: "edit",
    label: (a) => `Make ${a.variants?.length ?? ""} palette swaps`.replace("  ", " "),
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const frames = frameList(input.frames ?? "all", info.frames, info.frame);
      for (const f of frames) {
        const img = await layerPixels(aseprite, layer, f);
        for (const v of input.variants) {
          const out = applyMap(img, variantMap(v));
          await aseprite.request("put_image", { new_layer: v.name, above: layer, frame: f, width: out.width, height: out.height, rgba: send(out) });
        }
      }
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
    kind: "read",
    label: () => "Export palette LUT",
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const img = await layerPixels(aseprite, input.layer ?? info.layer, input.frame ?? info.frame);
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
