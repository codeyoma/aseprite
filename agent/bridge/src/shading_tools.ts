// Ramps, auto-shading and outlines as tools (#39). Pixels come from the
// layer's snapshot and go back through put_image, onto new 'AI:' layers.
import * as z from "zod/v4";
import { hex, parseHex, toOklch, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";
import { makeRamp, outline, shadeFlat, type LightDir } from "./shading.js";
import { findOutline } from "./style.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });

const framesSchema = z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional()
  .describe("Frames: 3, [1,2] or '1-4'. Default: the active frame.");

export function frameList(spec: unknown, count: number, active: number): number[] {
  if (spec === undefined) return [active];
  if (typeof spec === "number") return [spec];
  if (Array.isArray(spec)) return spec as number[];
  const m = /^(\d+)-(\d+)$/.exec(String(spec));
  if (m) return Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i).filter((f) => f <= count);
  if (String(spec) === "all") return Array.from({ length: count }, (_, i) => i + 1);
  return [Number(spec)];
}

export async function layerPixels(aseprite: AsepriteRequester, layer: string | undefined, frame: number): Promise<Rgba> {
  const { result, binary } = await aseprite.request("snapshot", { layer, frame });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

export async function spriteInfo(aseprite: AsepriteRequester): Promise<{ frames: number; frame: number; layer: string; palette: RGBA[] }> {
  const { result } = await aseprite.request("execute_lua", {
    code: `local s = app.sprite if not s then error("No active sprite") end
      local p, o = s.palettes[1], {}
      for i = 0, #p - 1 do local c = p:getColor(i) if c.alpha > 0 then o[#o + 1] = string.format("#%02x%02x%02x", c.red, c.green, c.blue) end end
      return { frames = #s.frames, frame = app.frame and app.frame.frameNumber or 1, layer = app.layer and app.layer.name or "", palette = o }`,
    transaction: false,
  });
  if (!result.ok) throw new Error(result.error);
  const v = result.value;
  return { frames: v.frames, frame: v.frame, layer: v.layer, palette: (v.palette as string[]).map((h) => parseHex(h)!) };
}

/** Only the pixels that differ from `before` (the rest transparent). */
function changedOnly(before: Rgba, after: Rgba): Uint8Array {
  const out = new Uint8Array(after.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const same = before.data[i + 3] === after.data[i + 3] && before.data[i] === after.data[i] && before.data[i + 1] === after.data[i + 1] && before.data[i + 2] === after.data[i + 2];
    if (!same) out.set(after.data.subarray(i, i + 4), i);
  }
  return out;
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
      if (input.add_to_palette) await aseprite.request("set_palette", { colors: ramp.map(hex), append: true, label: "Add ramp" });
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
      frames: framesSchema,
      light: z.enum(["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"]).optional(),
      bands: z.number().int().min(2).max(5).optional().describe("Shade steps per color. Default 3."),
      rim: z.boolean().optional().describe("Add a rim light on the side away from the light."),
      whole_shape: z.boolean().optional().describe("Shade the silhouette as one form instead of each color region."),
      snap_to_palette: z.boolean().optional().describe("Keep to the sprite palette (add ramps first with make_ramp)."),
    }),
    kind: "edit",
    label: (a) => `Shade${a.light ? ` from ${a.light}` : ""}`,
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const frames = frameList(input.frames, info.frames, info.frame);
      let ramps = 0;
      for (const f of frames) {
        const img = await layerPixels(aseprite, layer, f);
        const keep = findOutline(img).colors;
        const { image, ramps: r } = shadeFlat(img, {
          light: input.light as LightDir | undefined, bands: input.bands, rim: input.rim, perColor: !input.whole_shape, keep,
          palette: input.snap_to_palette ? info.palette : undefined,
        });
        ramps = Math.max(ramps, r.size);
        await aseprite.request("put_image", {
          new_layer: `shaded ${layer}`, above: layer, hide_source: true, frame: f,
          width: image.width, height: image.height, rgba: Buffer.from(image.data).toString("base64"),
        });
      }
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
      frames: framesSchema,
      mode: z.enum(["outer", "inner"]).optional(),
      connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
      color: z.string().optional().describe("'#rrggbb', 'darkest' (default) or 'selout'."),
    }),
    kind: "edit",
    label: (a) => `Outline${a.color === "selout" ? " (selout)" : ""}`,
    async run(input, aseprite) {
      const info = await spriteInfo(aseprite);
      const layer = input.layer ?? info.layer;
      const frames = frameList(input.frames, info.frames, info.frame);
      let pixels = 0;
      for (const f of frames) {
        const img = await layerPixels(aseprite, layer, f);
        const out = outline(img, { mode: input.mode, connectivity: input.connectivity, color: input.color ?? "darkest", palette: info.palette });
        const only = changedOnly(img, out);
        for (let i = 3; i < only.length; i += 4) if (only[i]) pixels++;
        await aseprite.request("put_image", {
          new_layer: "outline", above: layer, frame: f,
          width: out.width, height: out.height, rgba: Buffer.from(only).toString("base64"),
        });
      }
      return { content: [text(`Drew a ${input.mode ?? "outer"} ${input.color ?? "darkest"} outline (${pixels} px over ${frames.length} frame(s)) on 'AI: outline' above ${layer}.`)] };
    },
  },
];
