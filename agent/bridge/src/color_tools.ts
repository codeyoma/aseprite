// Palette and tone tools (#36, #38): extract a palette, compare tone, remap
// to a palette and adjust tone. The math is in color.ts; the extension
// gathers colors (collect_colors) and applies color maps (apply_color_map).
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as z from "zod/v4";
import {
  adjust, describeToneDifference, hex, hueHistogram, matchPalettes, nearDuplicates, nearest, parseHex, quantize, ramps, remap,
  tally, toneStats, toneTowards, type Counted, type RGBA,
} from "./color.js";
import { documentOf, type Document } from "./document.js";
import { findPalette, knownPalettes, parsePaletteFile } from "./palettes.js";
import { describeSource, framesInput, imageSource, readSource, resolvePalette, sourceFrames, sourceKind, sourceLayer, type ImageSource } from "./tool_inputs.js";
import { findOutline } from "./style.js";
import { failure, text, type AsepriteRequester, type Tool } from "./tool.js";

/** The colors of a source with pixel counts: a PNG's pixels, or the extension's count over the source's cels and frames (default all). */
export async function gatherColors(src: ImageSource, doc: Document): Promise<Counted[]> {
  const kind = sourceKind(src);
  if (kind === "file") {
    const { data } = (await readSource(src, doc)).image;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const v = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].map(([v, count]) => ({ r: v >>> 24, g: (v >>> 16) & 255, b: (v >>> 8) & 255, a: v & 255, count }));
  }
  return (await doc.colors({ layer: sourceLayer(src), frames: sourceFrames(src), selection: kind === "selection" })).colors;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(x < 0.01 ? 1 : 0)}%`;
}

/** The palette to remap to: hex colors, a palette file, or a palette by name (default the sprite's). */
async function targetPalette(t: { palette?: string; colors?: string[]; file?: string }, doc: Document): Promise<{ name: string; colors: RGBA[] }> {
  if (t.colors?.length) return { name: "the given colors", colors: t.colors.map((h) => parseHex(h)).filter((c): c is RGBA => !!c) };
  if (t.file) return { name: t.file, colors: parsePaletteFile(t.file) };
  const spec = t.palette || "sprite";
  const colors = (await resolvePalette(spec, doc)) ?? [];
  return { name: spec === "sprite" ? "the sprite palette" : findPalette(spec)?.name ?? spec, colors };
}

export const COLOR_TOOLS: Tool[] = [
  {
    name: "palette_from_image",
    title: "Extract palette",
    description:
      "The colors an image, layer, selection or the whole sprite uses: counts and shares, grouped into ramps (dark to " +
      "light), near-duplicate colors, and the closest palettes among those available (Aseprite's and the user's). " +
      "Reduces to max_colors with k-means in OKLab when there are more. Can set the result as the sprite palette, " +
      "draw swatches on an 'AI: palette' layer, or save it as a palette file (.gpl, .hex, .pal, .act, .col, or .aseprite/.png). " +
      "ignore_alpha_below skips soft edges; min_share drops colors used by too few pixels (anti-aliasing noise) before reducing.",
    input: imageSource.extend({
      max_colors: z.number().int().min(2).max(256).optional().describe("Default 32."),
      method: z.enum(["exact", "median-cut", "k-means"]).optional().describe("Default k-means (only used above max_colors)."),
      set_palette: z.boolean().optional().describe("Replace the sprite palette with the result."),
      swatches: z.boolean().optional().describe("Draw the palette on a new 'AI: palette' layer."),
      save: z.string().optional().describe("Save the palette here; the extension picks the format: .gpl, .hex, .pal, .act, .col, .aseprite, .png."),
      save_gpl: z.string().optional().describe("Same as save (older name)."),
      ignore_alpha_below: z.number().int().min(1).max(255).optional().describe("Pixels with less alpha don't count. Default 128."),
      min_share: z.number().min(0).max(0.5).optional().describe("Drop colors covering less than this share of the pixels (e.g. 0.002). Default 0."),
    }),
    kind: "edit",
    label: () => "Extract palette",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const counted = tally(await gatherColors(input, doc), input.ignore_alpha_below ?? 128);
      if (!counted.length) return failure(`No opaque pixels in ${describeSource(input)}.`);
      const pixelsCounted = counted.reduce((n, c) => n + c.count, 0);
      const all = input.min_share ? counted.filter((c) => c.count / pixelsCounted >= input.min_share!) : counted;
      if (!all.length) return failure(`No color covers ${pct(input.min_share!)} of ${describeSource(input)}.`);
      const dropped = counted.length - all.length;
      const max = input.max_colors ?? 32;
      const reduced = all.length > max;
      const colors = reduced ? quantize(all, max, input.method ?? "k-means") : all;
      const total = colors.reduce((s, c) => s + c.count, 0);
      const groups = ramps(colors);
      const dups = nearDuplicates(colors);
      const matches = matchPalettes(all, knownPalettes(), 3);
      const ordered = groups.flatMap((g) => g.colors);
      const lines = [
        `${describeSource(input)}: ${all.length} distinct colors${dropped ? ` (${dropped} rare color${dropped === 1 ? "" : "s"} under ${pct(input.min_share!)} dropped)` : ""}${reduced ? `, reduced to ${colors.length} (${input.method ?? "k-means"})` : ""}.`,
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
        await doc.setPalette(ordered, { label: "Palette from image" });
        lines.push(`Set the sprite palette to these ${ordered.length} colors.`);
      }
      if (input.swatches) {
        await doc.drawSwatches(ordered, { name: "palette" });
        lines.push("Drew swatches on a new 'AI: palette' layer.");
      }
      const save = input.save ?? input.save_gpl;
      if (save) {
        lines.push(`Saved ${await savePalette(save, ordered, aseprite)}.`);
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
  {
    name: "color_stats",
    title: "Compare tone",
    description:
      "Tone statistics of a source (mean lightness, saturation, contrast, warmth, color count, darkest/lightest), its " +
      "hue histogram, its outline color (the color around the shapes' edges, or selout) and its ramps with their step counts, and " +
      "with compare_to, how it differs from another source in plain words (e.g. 'darker overall, 20% more saturated').",
    input: imageSource.extend({ compare_to: imageSource.optional().describe("A second source to compare with.") }),
    kind: "read",
    label: () => "Compare tone",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const counted = tally(await gatherColors(input, doc));
      const a = toneStats(counted);
      const fmt = (s: ReturnType<typeof toneStats>) =>
        `${s.colors} colors, lightness ${s.lightness.toFixed(2)}, saturation ${s.chroma.toFixed(3)}, contrast ${s.contrast.toFixed(2)}, ` +
        `warmth ${s.warmth.toFixed(2)}, darkest ${s.darkest}, lightest ${s.lightest}`;
      const lines = [`${describeSource(input)}: ${fmt(a)}`];
      const hist = hueHistogram(counted);
      lines.push(`Hues: ${[...hist.hues.slice(0, 6).map((h) => `${h.name} ${pct(h.share)}`), ...(hist.neutral > 0.005 ? [`neutral ${pct(hist.neutral)}`] : [])].join(", ") || "none"}`);
      const groups = ramps(counted);
      lines.push(`Ramps: ${groups.length} (${groups.map((g) => `${g.name} ${g.colors.length} step${g.colors.length === 1 ? "" : "s"}`).join(", ")})`);
      const img = await readSource(input, doc).then((r) => r.image).catch(() => undefined);
      if (img) {
        const o = findOutline(img);
        lines.push(o.present
          ? `Outline: ${o.kind === "selout" ? "selout (each edge color darker than the fill beside it)" : o.colors.join(", ")}, on ${pct(o.coverage)} of the edge`
          : "Outline: none");
      }
      if (input.compare_to) {
        const b = toneStats(tally(await gatherColors(input.compare_to, doc)));
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
      frames: framesInput("all frames"),
      preserve_ramps: z.boolean().optional().describe("Default true."),
      set_palette: z.boolean().optional().describe("Also make it the sprite palette."),
    }),
    kind: "edit",
    label: (a) => (a.palette ? `Remap to ${a.palette}` : "Remap to palette"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const target = await targetPalette(input, doc);
      if (!target.colors.length) return failure("The target palette has no colors.");
      const source = tally(await gatherColors({ source: "layer", layer: input.layer, frames: input.frames }, doc));
      const map = remap(source, target.colors, input.preserve_ramps ?? true);
      const changes: Record<string, string> = {};
      for (const c of source) {
        const to = map.get(hex(c))!;
        if (hex(to) !== hex(c)) changes[hex(c)] = hex(to);
      }
      if (input.set_palette) await doc.setPalette(target.colors, { label: `Palette ${target.name}` });
      if (!Object.keys(changes).length) return { content: [text(`Already within ${target.name}; nothing changed.`)] };
      const result = await doc.applyColorMap(changes, { layer: input.layer, frames: input.frames, label: `Remap to ${target.name}` });
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
      frames: framesInput("all frames"),
      lightness: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(3).optional(),
      contrast: z.number().min(-1).max(3).optional(),
      hue: z.number().min(-180).max(180).optional(),
      match_to: imageSource.optional().describe("Move the tone towards this source's."),
      strength: z.number().min(0).max(1).optional().describe("For match_to. Default 1."),
      snap_to_palette: z.boolean().optional(),
    }),
    kind: "edit",
    label: () => "Adjust tone",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const source = tally(await gatherColors({ source: "layer", layer: input.layer, frames: input.frames }, doc));
      let o: { lightness?: number; chroma?: number; contrast?: number; hue?: number; pivot?: number } = {
        lightness: input.lightness, chroma: input.saturation, contrast: input.contrast, hue: input.hue,
      };
      let before = "";
      if (input.match_to) {
        const ref = toneStats(tally(await gatherColors(input.match_to, doc)));
        const now = toneStats(source);
        o = { ...toneTowards(now, ref, input.strength ?? 1), hue: input.hue };
        before = describeToneDifference(now, ref).join(", ");
      }
      const palette = input.snap_to_palette ? (await targetPalette({}, doc)).colors : undefined;
      const changes: Record<string, string> = {};
      const out: Counted[] = [];
      for (const c of source) {
        let to = adjust(c, o);
        if (palette?.length) to = { ...nearest(to, palette).color, a: c.a };
        out.push({ ...to, count: c.count });
        if (hex(to) !== hex(c)) changes[hex(c)] = hex(to);
      }
      if (!Object.keys(changes).length) return { content: [text("Nothing to change.")] };
      const result = await doc.applyColorMap(changes, { layer: input.layer, frames: input.frames, label: "Adjust tone" });
      const lines = [`Adjusted ${Object.keys(changes).length} colors (${result.changed} ${result.mode} changed). One undo step.`];
      if (input.match_to) {
        const after = describeToneDifference(toneStats(tally(out)), toneStats(tally(await gatherColors(input.match_to, doc))));
        lines.push(`Before: ${before || "already close"}. After: ${after.length ? after.join(", ") : "the tones match closely"}.`);
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
];

/**
 * Saves a palette by its extension: .gpl and .hex are written here, other
 * formats (.pal, .act, .col, .aseprite, .png…) by Aseprite.
 */
export async function savePalette(path: string, colors: RGBA[], aseprite: AsepriteRequester): Promise<string> {
  if (/\.gpl$/i.test(path)) writeFileSync(path, gpl(colors, basename(path).replace(/\.gpl$/i, "")));
  else if (/\.hex$/i.test(path)) writeFileSync(path, colors.map((c) => hex(c).slice(1)).join("\n") + "\n");
  else await aseprite.request("save_palette", { colors: colors.map(hex), path });
  return path;
}

export function gpl(colors: RGBA[], name: string): string {
  return ["GIMP Palette", `Name: ${name}`, "#", ...colors.map((c) => `${String(c.r).padStart(3)} ${String(c.g).padStart(3)} ${String(c.b).padStart(3)}\t${hex(c)}`)].join("\n") + "\n";
}
