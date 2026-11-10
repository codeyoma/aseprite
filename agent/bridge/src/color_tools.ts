// Palette and tone tools (#36, #38): extract a palette, compare tone, remap
// to a palette and adjust tone. The math is in color.ts; the extension
// gathers colors (collect_colors) and applies color maps (apply_color_map).
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import {
  adjust, describeToneDifference, hex, matchPalettes, nearDuplicates, nearest, parseHex, quantize, ramps, remap,
  tally, toneStats, toneTowards, type Counted, type RGBA,
} from "./color.js";
import { findPalette, knownPalettes, parsePaletteFile } from "./palettes.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });

/** Where colors come from: the sprite, a layer, the selection, or an image file (e.g. an attachment). */
export const sourceSchema = z.object({
  source: z.enum(["sprite", "layer", "selection", "file"]).optional()
    .describe("Default 'sprite' (all visible layers). 'file' reads an image path, e.g. an attachment."),
  layer: z.string().optional().describe("Layer id like 'L3' or name (source 'layer', or limits 'selection')."),
  frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional()
    .describe("Frames: 3, [1,2] or '1-4'. Default: all."),
  path: z.string().optional().describe("Image file for source 'file' (PNG)."),
});
type Source = z.infer<typeof sourceSchema>;

export function decodePng(buf: Buffer): Counted[] {
  const png = PNG.sync.read(buf);
  const counts = new Map<number, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    const v = png.data.readUInt32BE(i) >>> 0;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([v, count]) => ({ r: v >>> 24, g: (v >>> 16) & 255, b: (v >>> 8) & 255, a: v & 255, count }));
}

export async function gatherColors(src: Source, aseprite: AsepriteRequester): Promise<Counted[]> {
  if (src.source === "file") {
    if (!src.path) throw new Error("source 'file' needs a path");
    if (!/\.png$/i.test(src.path)) throw new Error("Only PNG files can be read; attach the image as PNG");
    return decodePng(readFileSync(src.path));
  }
  const { result } = await aseprite.request("collect_colors", {
    layer: src.layer, frames: src.frames, selection: src.source === "selection",
  });
  return (result.colors as { hex: string; count: number }[])
    .map((c) => ({ ...parseHex(c.hex)!, count: c.count }));
}

function describeSource(s: Source): string {
  if (s.source === "file") return s.path ?? "the image";
  if (s.source === "selection") return "the selection";
  if (s.layer) return `layer ${s.layer}`;
  return "the sprite";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x < 0.01 ? 1 : 0)}%`;
}

/** The palette to remap to: a known palette by name, hex colors, a palette file, or the sprite's palette. */
async function targetPalette(t: { palette?: string; colors?: string[]; file?: string }, aseprite: AsepriteRequester): Promise<{ name: string; colors: RGBA[] }> {
  if (t.colors?.length) return { name: "the given colors", colors: t.colors.map((h) => parseHex(h)).filter((c): c is RGBA => !!c) };
  if (t.file) return { name: t.file, colors: parsePaletteFile(t.file) };
  if (t.palette && t.palette !== "sprite") {
    const p = findPalette(t.palette);
    if (!p) throw new Error(`No palette named ${t.palette}. Known: ${knownPalettes().map((x) => x.name).slice(0, 40).join(", ")}…`);
    return p;
  }
  const { result } = await aseprite.request("get_palette", {});
  return { name: "the sprite palette", colors: (result.colors as string[]).map((h) => parseHex(h)!).filter((c) => c.a > 0) };
}

export const COLOR_TOOLS: Tool[] = [
  {
    name: "palette_from_image",
    title: "Extract palette",
    description:
      "The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to " +
      "light), near-duplicate colors, and the closest palettes among those available (Aseprite's and the user's). " +
      "Reduces to max_colors with k-means in OKLab when there are more. Can set the result as the sprite palette, " +
      "draw swatches on an 'AI: palette' layer, or save a .gpl file.",
    input: sourceSchema.extend({
      max_colors: z.number().int().min(2).max(256).optional().describe("Default 32."),
      method: z.enum(["exact", "median-cut", "k-means"]).optional().describe("Default k-means (only used above max_colors)."),
      set_palette: z.boolean().optional().describe("Replace the sprite palette with the result."),
      swatches: z.boolean().optional().describe("Draw the palette on a new 'AI: palette' layer."),
      save_gpl: z.string().optional().describe("Save the palette as a GIMP .gpl file at this path."),
    }),
    kind: "edit",
    label: () => "Extract palette",
    async run(input, aseprite) {
      const all = tally(await gatherColors(input, aseprite));
      if (!all.length) return failure(`No opaque pixels in ${describeSource(input)}.`);
      const max = input.max_colors ?? 32;
      const reduced = all.length > max;
      const colors = reduced ? quantize(all, max, input.method ?? "k-means") : all;
      const total = colors.reduce((s, c) => s + c.count, 0);
      const groups = ramps(colors);
      const dups = nearDuplicates(colors);
      const matches = matchPalettes(all, knownPalettes(), 3);
      const ordered = groups.flatMap((g) => g.colors);
      const lines = [
        `${describeSource(input)}: ${all.length} distinct colors${reduced ? `, reduced to ${colors.length} (${input.method ?? "k-means"})` : ""}.`,
        "Ramps (dark to light):",
        ...groups.map((g) => `- ${g.name}: ${g.colors.map((c) => `${hex(c)} ${pct(((c as Counted).count ?? 0) / total)}`).join(", ")}`),
      ];
      if (dups.length) lines.push(`Near-duplicates (merge unless deliberate): ${dups.slice(0, 8).map(([a, b]) => `${hex(a)}~${hex(b)}`).join(", ")}`);
      if (all.length > 64) lines.push(`Warning: ${all.length} colors is a lot for pixel art; consider reducing.`);
      if (matches.length) {
        lines.push("Closest among available palettes:", ...matches.map((m) =>
          `- ${m.name} (${m.size} colors): ${pct(m.coverage)} of pixels match closely, mean error ${m.error.toFixed(3)}`));
      }
      if (input.set_palette) {
        await aseprite.request("set_palette", { colors: ordered.map(hex), label: "Palette from image" });
        lines.push(`Set the sprite palette to these ${ordered.length} colors.`);
      }
      if (input.swatches) {
        await aseprite.request("draw_swatches", { colors: ordered.map(hex), name: "palette" });
        lines.push("Drew swatches on a new 'AI: palette' layer.");
      }
      if (input.save_gpl) {
        writeFileSync(input.save_gpl, gpl(ordered, "Extracted"));
        lines.push(`Saved ${input.save_gpl}.`);
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
  {
    name: "color_stats",
    title: "Compare tone",
    description:
      "Tone statistics of a source (mean lightness, saturation, contrast, warmth, color count, darkest/lightest), and " +
      "with compare_to, how it differs from another source in plain words (e.g. 'darker overall, 20% more saturated').",
    input: sourceSchema.extend({ compare_to: sourceSchema.optional().describe("A second source to compare with.") }),
    kind: "read",
    label: () => "Compare tone",
    async run(input, aseprite) {
      const a = toneStats(tally(await gatherColors(input, aseprite)));
      const fmt = (s: ReturnType<typeof toneStats>) =>
        `${s.colors} colors, lightness ${s.lightness.toFixed(2)}, saturation ${s.chroma.toFixed(3)}, contrast ${s.contrast.toFixed(2)}, ` +
        `warmth ${s.warmth.toFixed(2)}, darkest ${s.darkest}, lightest ${s.lightest}`;
      const lines = [`${describeSource(input)}: ${fmt(a)}`];
      if (input.compare_to) {
        const b = toneStats(tally(await gatherColors(input.compare_to, aseprite)));
        lines.push(`${describeSource(input.compare_to)}: ${fmt(b)}`);
        const diff = describeToneDifference(a, b);
        lines.push(diff.length ? `Compared with it, ${describeSource(input)} is ${diff.join(", ")}.` : "The tones match closely.");
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
  {
    name: "remap_to_palette",
    title: "Remap to palette",
    description:
      "Recolor a layer or the sprite so it uses only a palette's colors, by perceptual distance (OKLab). Shading ramps " +
      "stay in one target ramp and keep their dark-to-light order. The palette: a known one by name (e.g. 'PICO-8', " +
      "'EDG32'; see palette_from_image), hex colors, a .gpl/.hex file, or the sprite palette. One undo step.",
    input: z.object({
      palette: z.string().optional().describe("Palette name, or 'sprite' (default)."),
      colors: z.array(z.string()).optional().describe("Hex colors to use instead of a named palette."),
      file: z.string().optional().describe("A .gpl or .hex palette file."),
      layer: z.string().optional().describe("Only this layer (id or name). Default: all visible layers."),
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional(),
      preserve_ramps: z.boolean().optional().describe("Default true."),
      set_palette: z.boolean().optional().describe("Also make it the sprite palette."),
    }),
    kind: "edit",
    label: (a) => (a.palette ? `Remap to ${a.palette}` : "Remap to palette"),
    async run(input, aseprite) {
      const target = await targetPalette(input, aseprite);
      if (!target.colors.length) return failure("The target palette has no colors.");
      const source = tally(await gatherColors({ source: "layer", layer: input.layer, frames: input.frames }, aseprite));
      const map = remap(source, target.colors, input.preserve_ramps ?? true);
      const changes: Record<string, string> = {};
      for (const c of source) {
        const to = map.get(hex(c))!;
        if (hex(to) !== hex(c)) changes[hex(c)] = hex(to);
      }
      if (input.set_palette) await aseprite.request("set_palette", { colors: target.colors.map(hex), label: `Palette ${target.name}` });
      if (!Object.keys(changes).length) return { content: [text(`Already within ${target.name}; nothing changed.`)] };
      const { result } = await aseprite.request("apply_color_map", {
        map: changes, layer: input.layer, frames: input.frames, label: `Remap to ${target.name}`,
      });
      const err = source.reduce((s, c) => s + nearest(c, target.colors).d * c.count, 0) / Math.max(1, source.reduce((s, c) => s + c.count, 0));
      return {
        content: [text(`Remapped ${Object.keys(changes).length} of ${source.length} colors to ${target.name} ` +
          `(${result.changed} ${result.mode} changed, mean color shift ${err.toFixed(3)}). One undo step.`)],
      };
    },
  },
  {
    name: "adjust_tone",
    title: "Adjust tone",
    description:
      "Shift a layer's or the sprite's tone in OKLCH: lightness (-1..1, small values like 0.05), saturation and " +
      "contrast (relative, e.g. -0.2 = 20% less), hue rotation in degrees; or match_to another source's tone (with " +
      "strength 0..1). snap_to_palette keeps the result within the sprite palette. One undo step.",
    input: z.object({
      layer: z.string().optional(),
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional(),
      lightness: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(3).optional(),
      contrast: z.number().min(-1).max(3).optional(),
      hue: z.number().min(-180).max(180).optional(),
      match_to: sourceSchema.optional().describe("Move the tone towards this source's."),
      strength: z.number().min(0).max(1).optional().describe("For match_to. Default 1."),
      snap_to_palette: z.boolean().optional(),
    }),
    kind: "edit",
    label: () => "Adjust tone",
    async run(input, aseprite) {
      const source = tally(await gatherColors({ source: "layer", layer: input.layer, frames: input.frames }, aseprite));
      let o: { lightness?: number; chroma?: number; contrast?: number; hue?: number; pivot?: number } = {
        lightness: input.lightness, chroma: input.saturation, contrast: input.contrast, hue: input.hue,
      };
      let before = "";
      if (input.match_to) {
        const ref = toneStats(tally(await gatherColors(input.match_to, aseprite)));
        const now = toneStats(source);
        o = { ...toneTowards(now, ref, input.strength ?? 1), hue: input.hue };
        before = describeToneDifference(now, ref).join(", ");
      }
      const palette = input.snap_to_palette ? (await targetPalette({}, aseprite)).colors : undefined;
      const changes: Record<string, string> = {};
      const out: Counted[] = [];
      for (const c of source) {
        let to = adjust(c, o);
        if (palette?.length) to = { ...nearest(to, palette).color, a: c.a };
        out.push({ ...to, count: c.count });
        if (hex(to) !== hex(c)) changes[hex(c)] = hex(to);
      }
      if (!Object.keys(changes).length) return { content: [text("Nothing to change.")] };
      const { result } = await aseprite.request("apply_color_map", { map: changes, layer: input.layer, frames: input.frames, label: "Adjust tone" });
      const lines = [`Adjusted ${Object.keys(changes).length} colors (${result.changed} ${result.mode} changed). One undo step.`];
      if (input.match_to) {
        const after = describeToneDifference(toneStats(tally(out)), toneStats(tally(await gatherColors(input.match_to, aseprite))));
        lines.push(`Before: ${before || "already close"}. After: ${after.length ? after.join(", ") : "the tones match closely"}.`);
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
];

export function gpl(colors: RGBA[], name: string): string {
  return ["GIMP Palette", `Name: ${name}`, "#", ...colors.map((c) => `${String(c.r).padStart(3)} ${String(c.g).padStart(3)} ${String(c.b).padStart(3)}\t${hex(c)}`)].join("\n") + "\n";
}
