// Normal maps and 2D lighting as tools (#47).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { documentOf } from "./document.js";
import { emissionMask, specularMask } from "./masks.js";
import { light, normalMap } from "./normals.js";
import { blank, writePng, type Rgba } from "./image.js";
import { encodeSnapshot } from "./png.js";
import { framesInput } from "./tool_inputs.js";
import { text, type Tool } from "./tool.js";

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

const hexList = z.array(z.string()).optional();

/** The mask layers made by make_masks for a layer, when they exist. */
async function maskLayers(doc: ReturnType<typeof documentOf>, layer: string) {
  const names = new Set((await doc.info()).layers.map((l) => l.name));
  const has = (k: string) => (names.has(`AI: ${k} ${layer}`) ? `AI: ${k} ${layer}` : undefined);
  return { emission: has("emission"), specular: has("specular") };
}

function writeStrip(path: string, frames: Rgba[]) {
  const w = frames[0].width, h = frames[0].height;
  const strip = blank(w * frames.length, h);
  frames.forEach((f, i) => {
    for (let y = 0; y < h; y++) strip.data.set(f.data.subarray(y * w * 4, (y + 1) * w * 4), (y * w * frames.length + i * w) * 4);
  });
  writePng(path, strip);
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
      frames: framesInput("all frames"),
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
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames ?? "all");
      for (const f of frames) {
        const img = await doc.pixels(layer, f);
        const height = input.height_layer ? await doc.pixels(input.height_layer, f) : undefined;
        const n = normalMap(img, {
          source: input.source ?? (height ? "height" : "bevel"), height, bevel: input.bevel, strength: input.strength,
          levels: input.levels, convention: input.convention,
        });
        await doc.putImage(n, { newLayer: `normal ${layer}`, above: layer, hide: true, frame: f });
      }
      return { content: [text(`Made a ${input.convention ?? "opengl"} normal map of ${layer} (${input.source ?? "bevel"}) for ${frames.length} frame(s) on the hidden layer 'AI: normal ${layer}'. Preview it with light_preview.`)] };
    },
  },
  {
    name: "make_masks",
    title: "Make emission and specular masks",
    description:
      "Make grayscale material masks for a layer, beside its normal map, for engines with 2D lights. 'emission': the " +
      "pixels that glow (lamps, eyes, magic) picked by colors, by a lightness/chroma threshold (default: bright and " +
      "saturated), or from a layer you painted; white (or their own color) on black. 'specular': how shiny, by colors " +
      "(e.g. a metal ramp) with a flat value or following lightness, or from lightness alone (highlights); gray steps " +
      "quantized for pixel art. Written to hidden 'AI: emission <layer>' / 'AI: specular <layer>' layers, every frame " +
      "you choose; paint fixes on them. light_preview and export_normal_sheet use them.",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("all frames"),
      kind: z.enum(["emission", "specular", "both"]).optional().describe("Default both."),
      emission: z.object({
        colors: hexList.describe("These colors glow."),
        tolerance: z.number().min(0).max(0.5).optional().describe("OKLab distance still counted as the same color. Default 0.02."),
        min_lightness: z.number().min(0).max(1).optional().describe("Threshold pick (no colors/layer): OKLCH lightness. Default 0.7."),
        min_chroma: z.number().min(0).max(0.4).optional().describe("Threshold pick: OKLCH chroma. Default 0.1."),
        layer: z.string().optional().describe("A layer you painted: its opaque pixels glow."),
        keep_color: z.boolean().optional().describe("Write the glow's own color instead of white."),
      }).optional(),
      specular: z.object({
        colors: hexList.describe("Only these colors are shiny (e.g. a metal ramp)."),
        tolerance: z.number().min(0).max(0.5).optional(),
        value: z.number().min(0).max(1).optional().describe("Flat shine for the chosen colors. Default: follows lightness."),
        values: z.record(z.string(), z.number().min(0).max(1)).optional().describe("Flat shine per color, by hex."),
        min_lightness: z.number().min(0).max(0.99).optional().describe("Lightness where shine starts. Default 0.5."),
        levels: z.number().int().min(0).max(16).optional().describe("Gray steps (0 = smooth). Default 4."),
        layer: z.string().optional().describe("A grayscale layer you painted (white = shiny)."),
      }).optional(),
    }),
    kind: "edit",
    label: (a) => (a.kind && a.kind !== "both" ? `Make ${a.kind} mask` : "Make masks"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames ?? "all");
      const kinds = !input.kind || input.kind === "both" ? ["emission", "specular"] as const : [input.kind];
      const e = input.emission ?? {}, s = input.specular ?? {};
      const lit: Record<string, number> = { emission: 0, specular: 0 };
      for (const f of frames) {
        const img = await doc.pixels(layer, f);
        for (const k of kinds) {
          const paintedLayer = k === "emission" ? e.layer : s.layer;
          const painted = paintedLayer ? await doc.pixels(paintedLayer, f) : undefined;
          const mask = k === "emission"
            ? emissionMask(img, { colors: e.colors, tolerance: e.tolerance, minLightness: e.min_lightness, minChroma: e.min_chroma, painted, keepColor: e.keep_color })
            : specularMask(img, { colors: s.colors, tolerance: s.tolerance, value: s.value, values: s.values, minLightness: s.min_lightness, levels: s.levels, painted });
          for (let i = 0; i < mask.data.length; i += 4) if (mask.data[i + 3] && (mask.data[i] || mask.data[i + 1] || mask.data[i + 2])) lit[k]++;
          await doc.putImage(mask, { newLayer: `${k} ${layer}`, above: layer, hide: true, frame: f });
        }
      }
      const said = kinds.map((k) => `'AI: ${k} ${layer}' (${lit[k]} ${k === "emission" ? "glowing" : "shiny"} px)`).join(" and ");
      const none = kinds.filter((k) => !lit[k]);
      return { content: [text(`Made ${said} for ${frames.length} frame(s), hidden. ` +
        (none.length ? `No ${none.join("/")} pixels were picked; try colors or a lower threshold. ` : "") + "Preview with light_preview.")] };
    },
  },
  {
    name: "light_preview",
    title: "Preview lighting",
    description:
      "Render a layer lit through its normal map ('AI: normal <layer>' by default) by a directional or point light, and " +
      "return the image. Uses the 'AI: emission/specular <layer>' masks when they exist (masks: false to skip): glow " +
      "shows unlit, shiny pixels get a highlight. Changes nothing.",
    input: z.object({
      layer: z.string().optional(),
      normal_layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      light: lightSchema.optional(),
      convention: z.enum(["opengl", "directx"]).optional(),
      masks: z.boolean().optional().describe("Use the emission/specular masks if present. Default true."),
    }),
    kind: "read",
    label: () => "Preview lighting",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const f = input.frame ?? info.frame;
      const albedo = await doc.pixels(layer, f);
      const normals = await doc.pixels(input.normal_layer ?? `AI: normal ${layer}`, f);
      const l = input.light ?? {};
      const m: { emission?: string; specular?: string } = input.masks === false ? {} : await maskLayers(doc, layer);
      const masks = {
        emission: m.emission ? await doc.pixels(m.emission, f) : undefined,
        specular: m.specular ? await doc.pixels(m.specular, f) : undefined,
      };
      const lit = light(albedo, normals, {
        dir: l.point ? undefined : DIRS[l.from ?? "top-left"],
        point: l.point ? [l.point.x, l.point.y, l.point.z ?? 12] : undefined,
        ambient: l.ambient,
      }, input.convention ?? "opengl", masks);
      const used = [m.emission && "emission", m.specular && "specular"].filter(Boolean);
      const png = encodeSnapshot(Buffer.from(lit.data), lit.width, lit.height, Math.max(1, Math.floor(256 / Math.max(lit.width, lit.height))), "checker");
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, text(`${layer} lit from ${l.point ? `a point at ${l.point.x},${l.point.y}` : l.from ?? "top-left"}${used.length ? ` with the ${used.join(" and ")} mask${used.length > 1 ? "s" : ""}` : ""}.`)] };
    },
  },
  {
    name: "export_normal_sheet",
    title: "Export color and normal sheets",
    description:
      "Write <name>.png (the layer's frames side by side) and <name>_n.png (its normal map frames, same layout) for an " +
      "engine's 2D lights, plus <name>_e.png / <name>_s.png from the 'AI: emission/specular <layer>' masks when they exist.",
    input: z.object({
      layer: z.string().optional(),
      normal_layer: z.string().optional(),
      frames: framesInput("all frames"),
      dir: z.string(),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: () => "Export normal sheet",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames ?? "all");
      const m = await maskLayers(doc, layer);
      const sheets: [string, string | undefined][] = [["", layer], ["_n", input.normal_layer ?? `AI: normal ${layer}`], ["_e", m.emission], ["_s", m.specular]];
      const name = input.name ?? layer.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      mkdirSync(input.dir, { recursive: true });
      const files: string[] = [];
      let size = "";
      for (const [suffix, src] of sheets) {
        if (!src) continue;
        const imgs: Rgba[] = [];
        for (const f of frames) imgs.push(await doc.pixels(src, f));
        writeStrip(join(input.dir, `${name}${suffix}.png`), imgs);
        files.push(`${name}${suffix}.png`);
        size ||= `${imgs[0].width}x${imgs[0].height}`;
      }
      return { content: [text(`Wrote ${files.join(", ")} (${frames.length} frames of ${size}, side by side) to ${input.dir}.`)] };
    },
  },
];
