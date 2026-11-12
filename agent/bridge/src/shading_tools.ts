// Ramps, auto-shading and outlines as tools (#39). Pixels come from the
// document and go back onto new 'AI:' layers.
import * as z from "zod/v4";
import { hex, parseHex, toOklch } from "./color.js";
import { documentOf, type PutImagesItem } from "./document.js";
import type { Rgba } from "./image.js";
import { heightField } from "./normals.js";
import { ambientOcclusion, antiAlias, applyOcclusion, makeRamp, outline, shadeFlat, type LightDir } from "./shading.js";
import { findOutline } from "./style.js";
import { framesInput } from "./tool_inputs.js";
import { failure, text, type Tool } from "./tool.js";


/** Only the pixels that differ from `before` (the rest transparent). */
function changedOnly(before: Rgba, after: Rgba): Rgba {
  const out = new Uint8Array(after.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const same = before.data[i + 3] === after.data[i + 3] && before.data[i] === after.data[i] && before.data[i + 1] === after.data[i + 1] && before.data[i + 2] === after.data[i + 2];
    if (!same) out.set(after.data.subarray(i, i + 4), i);
  }
  return { width: after.width, height: after.height, data: out };
}

export const SHADING_TOOLS: Tool[] = [
  {
    name: "make_ramp",
    title: "Make color ramp",
    description:
      "A pixel-art color ramp through a base color, dark to light, with hue shifting (shadows turn cool toward " +
      "blue/purple, highlights warm toward yellow) and softer saturation at the ends. Can add it to the palette.",
    input: z.object({
      base: z.string().describe("Base color, e.g. '#3caa50' (stays in the ramp)."),
      steps: z.number().int().min(2).max(9).optional().describe("Default 5."),
      hue_shift: z.number().min(0).max(90).optional().describe("Degrees from darkest to lightest. Default 30."),
      add_to_palette: z.boolean().optional(),
    }),
    kind: "edit",
    label: (a) => (a.base ? `Make ramp from ${a.base}` : "Make ramp"),
    async run(input, aseprite) {
      const base = parseHex(input.base);
      if (!base) return failure(`Not a color: ${input.base}`);
      const ramp = makeRamp(base, { steps: input.steps, hueShift: input.hue_shift });
      if (input.add_to_palette) await documentOf(aseprite).setPalette(ramp, { append: true, label: "Add ramp" });
      return {
        content: [text(`Ramp (dark to light): ${ramp.map(hex).join(" ")} — lightness ${ramp.map((c) => toOklch(c).L.toFixed(2)).join(", ")}` +
          (input.add_to_palette ? ". Added to the palette." : "."))],
      };
    },
  },
  {
    name: "shade_sprite",
    title: "Shade sprite",
    description:
      "Shade a flat-colored layer: each flat color becomes a small hue-shifted ramp, and every pixel takes a step " +
      "from the shape's estimated form lit from `light`. The outline color (found automatically) stays. The result " +
      "goes on a new 'AI: shaded <layer>' layer and the original is hidden, so it's easy to compare or undo.",
    input: z.object({
      layer: z.string().optional().describe("Layer name. Default: the active layer."),
      frames: framesInput("the active frame"),
      light: z.enum(["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
      bands: z.number().int().min(2).max(5).optional().describe("Shade steps per color. Default 3."),
      rim: z.boolean().optional().describe("Add a rim light on the side away from the light."),
      whole_shape: z.boolean().optional().describe("Shade the silhouette as one form instead of each color region."),
      snap_to_palette: z.boolean().optional().describe("Keep to the sprite palette (add ramps first with make_ramp)."),
    }),
    kind: "edit",
    label: (a) => `Shade${a.light ? ` from ${a.light}` : ""}`,
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames);
      let ramps = 0;
      // Every frame read in one request and written in one undo step (#114).
      const imgs = await doc.pixelsMany(layer, frames);
      const items: PutImagesItem[] = [];
      for (const [i, f] of frames.entries()) {
        const img = imgs[i];
        const keep = findOutline(img).colors;
        const { image, ramps: r } = shadeFlat(img, {
          light: input.light as LightDir | undefined, bands: input.bands, rim: input.rim, perColor: !input.whole_shape, keep,
          palette: input.snap_to_palette ? info.palette : undefined,
        });
        ramps = Math.max(ramps, r.size);
        items.push({ image, newLayer: `shaded ${layer}`, above: layer, hideSource: true, frame: f });
      }
      await doc.putImages(items, { label: "Shade" });
      return { content: [text(`Shaded ${layer} in ${frames.length} frame(s) from ${input.light ?? "top-left"} with ${input.bands ?? 3} bands ` +
        `(${ramps} color ramps) on 'AI: shaded ${layer}'; the original is hidden.`)] };
    },
  },
  {
    name: "outline_sprite",
    title: "Outline",
    description:
      "Outline a layer's shapes: outer (around them) or inner (their edge pixels), 4-connected (rounder, usual) or " +
      "8-connected, in one color, 'darkest' (the palette's darkest) or 'selout' (a darker shade of the color each " +
      "outline pixel borders). The outline goes on a new 'AI: outline' layer above.",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("the active frame"),
      mode: z.enum(["outer", "inner"]).optional(),
      connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
      color: z.string().optional().describe("'#rrggbb', 'darkest' (default) or 'selout'."),
    }),
    kind: "edit",
    label: (a) => `Outline${a.color === "selout" ? " (selout)" : ""}`,
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames);
      let pixels = 0;
      const imgs = await doc.pixelsMany(layer, frames);
      const items: PutImagesItem[] = [];
      for (const [i, f] of frames.entries()) {
        const img = imgs[i];
        const out = outline(img, { mode: input.mode, connectivity: input.connectivity, color: input.color ?? "darkest", palette: info.palette });
        const only = changedOnly(img, out);
        for (let k = 3; k < only.data.length; k += 4) if (only.data[k]) pixels++;
        items.push({ image: only, newLayer: "outline", above: layer, frame: f });
      }
      await doc.putImages(items, { label: "Outline" });
      return { content: [text(`Drew a ${input.mode ?? "outer"} ${input.color ?? "darkest"} outline (${pixels} px over ${frames.length} frame(s)) on 'AI: outline' above ${layer}.`)] };
    },
  },
  {
    name: "anti_alias",
    title: "Anti-alias steps",
    description:
      "Manual anti-aliasing: in each jagged step between two colors inside a layer (line art against fill, one shade " +
      "against the next), the pixel in the step's inner corner takes a color between the two, as pixel artists do by " +
      "hand. Never blends into the transparent background, and leaves 1 px lines thin. With snap_to_palette the new " +
      "colors are palette colors. The added pixels go on an 'AI: anti-alias <layer>' layer above, so they can be toggled.",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("the active frame"),
      strength: z.number().min(0.2).max(1).optional().describe("How far toward the other color: 1 = halfway (default)."),
      snap_to_palette: z.boolean().optional().describe("Use the nearest sprite palette colors. Default true when the palette has colors."),
    }),
    kind: "edit",
    label: () => "Anti-alias steps",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames);
      const palette = input.snap_to_palette === false || !info.palette.length ? undefined : info.palette;
      let changed = 0;
      const imgs = await doc.pixelsMany(layer, frames);
      const items: PutImagesItem[] = [];
      for (const [i, f] of frames.entries()) {
        const r = antiAlias(imgs[i], { palette, strength: input.strength });
        changed += r.changed;
        if (r.changed) items.push({ image: r.image, newLayer: `anti-alias ${layer}`, above: layer, frame: f });
      }
      if (items.length) await doc.putImages(items, { label: "Anti-alias" });
      if (!changed) return { content: [text(`No jagged steps between colors in ${layer}: nothing to anti-alias.`)] };
      return { content: [text(`Softened ${changed} step corner(s) in ${frames.length} frame(s) of ${layer} on 'AI: anti-alias ${layer}'${palette ? " with palette colors" : ""}.`)] };
    },
  },
  {
    name: "ambient_occlusion",
    title: "Ambient occlusion",
    description:
      "Darken creases and contact areas: occlusion from a height field (a grayscale 'height_layer', or one made from " +
      "the shape: 'bevel' rounds from the silhouette, 'luminance' treats light as high), quantized to a few levels. " +
      "Applied, each level darkens one palette-aware shade onto 'AI: ao <layer>' (the original is hidden); or " +
      "as_mask writes a grayscale mask on a hidden 'AI: ao mask <layer>' layer (for engines or manual painting).",
    input: z.object({
      layer: z.string().optional(),
      frames: framesInput("the active frame"),
      height_layer: z.string().optional().describe("A grayscale height layer (white = high)."),
      source: z.enum(["bevel", "luminance"]).optional().describe("Height from the shape when there's no height layer. Default bevel."),
      radius: z.number().int().min(1).max(8).optional().describe("How far around a pixel occludes it. Default 2."),
      levels: z.number().int().min(1).max(3).optional().describe("Darkness steps. Default 2."),
      strength: z.number().min(0.2).max(3).optional().describe("Default 1."),
      as_mask: z.boolean().optional(),
    }),
    kind: "edit",
    label: () => "Ambient occlusion",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const layer = input.layer ?? info.layer;
      const frames = await doc.frames(input.frames);
      let shaded = 0;
      const imgs = await doc.pixelsMany(layer, frames);
      const heights = input.height_layer ? await doc.pixelsMany(input.height_layer, frames) : undefined;
      const items: PutImagesItem[] = [];
      for (const [i, f] of frames.entries()) {
        const img = imgs[i];
        const hl = heights?.[i];
        const height = heightField(img, hl ? { source: "height", height: hl } : { source: input.source ?? "bevel" });
        const occ = ambientOcclusion(img, height, { radius: input.radius, levels: input.levels, strength: input.strength });
        for (const v of occ) if (v) shaded++;
        if (input.as_mask) {
          const levels = input.levels ?? 2;
          const mask = new Uint8Array(img.data.length);
          for (let i = 0; i < occ.length; i++) {
            if (img.data[i * 4 + 3] < 128) continue;
            const g = Math.round(255 * (1 - occ[i] / levels));
            mask.set([g, g, g, 255], i * 4);
          }
          items.push({ image: { width: img.width, height: img.height, data: mask }, newLayer: `ao mask ${layer}`, above: layer, hide: true, frame: f });
        } else {
          items.push({ image: applyOcclusion(img, occ, info.palette.length ? info.palette : undefined), newLayer: `ao ${layer}`, above: layer, hideSource: true, frame: f });
        }
      }
      await doc.putImages(items, { label: "Ambient occlusion" });
      const where = input.as_mask ? `a mask on the hidden layer 'AI: ao mask ${layer}' (white = open, darker = occluded)` : `'AI: ao ${layer}' (the original is hidden)`;
      return { content: [text(`Occluded ${shaded} px over ${frames.length} frame(s) of ${layer}: ${where}.`)] };
    },
  },
];
