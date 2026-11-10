// 3D model to pixel sprites as a tool (#44).
import * as z from "zod/v4";
import { hex, nearest, type RGBA } from "./color.js";
import { DIRECTIONS_4, DIRECTIONS_8 } from "./directions.js";
import { ELEVATIONS, fitFrame, loadModel, renderView, type View } from "./model3d.js";
import { findPalette } from "./palettes.js";
import type { Rgba } from "./pixel_grid.js";
import { encodeSnapshot } from "./png.js";
import { outline } from "./shading.js";
import { spriteInfo } from "./shading_tools.js";
import { failure, text, type Tool, type ToolResult } from "./tool.js";


/** Facing names by camera azimuth: 0 sees the model's front (it faces the viewer: S). */
export function directionNames(n: number): string[] {
  if (n === 8) return [...DIRECTIONS_8];
  if (n === 4) return [...DIRECTIONS_4];
  if (n === 1) return ["S"];
  return Array.from({ length: n }, (_, i) => `d${Math.round((i * 360) / n)}`);
}

function snap(img: Rgba, palette: RGBA[]): Rgba {
  const memo = new Map<number, RGBA>();
  const d = new Uint8Array(img.data);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let c = memo.get(k);
    if (!c) {
      c = nearest({ r: d[i], g: d[i + 1], b: d[i + 2], a: 255 }, palette).color;
      memo.set(k, c);
    }
    d.set([c.r, c.g, c.b], i);
  }
  return { width: img.width, height: img.height, data: d };
}

export const MODEL_TOOLS: Tool[] = [
  {
    name: "render_model",
    title: "Render 3D model to sprites",
    description:
      "Render a 3D model (.glb, .gltf or .obj) into pixel-art sprites: an orthographic camera at an elevation " +
      "('side', 'three-quarter', 'isometric', 'top-down' or degrees), 1/4/8/16 directions (tags S, SW, W, …, the " +
      "model's front facing the viewer in S), toon lighting in a few bands, no anti-aliasing, an outline, and colors " +
      "snapped to a palette. glTF animations on node transforms (rigid parts) are sampled at fps into frames, a tag " +
      "per clip and direction; skinned meshes render in their bind pose. Every frame shares one scale and ground " +
      "line. preview: true returns one frame without creating anything.",
    input: z.object({
      path: z.string(),
      size: z.number().int().min(8).max(256).optional().describe("Frame width and height in px. Default 32."),
      directions: z.union([z.literal(1), z.literal(4), z.literal(8), z.literal(16)]).optional().describe("Default 8."),
      elevation: z.union([z.enum(["side", "three-quarter", "isometric", "top-down"]), z.number().min(0).max(90)]).optional(),
      bands: z.number().int().min(2).max(5).optional().describe("Toon light steps. Default 3."),
      animation: z.string().optional().describe("A clip name, 'all' (default when the model has clips) or 'none'."),
      fps: z.number().min(1).max(30).optional().describe("Frames per second when sampling clips. Default 10."),
      outline: z.enum(["none", "darkest", "selout"]).optional().describe("Default darkest."),
      palette: z.string().optional().describe("'sprite' (the active sprite's), a palette name like 'PICO-8', or 'none' (default)."),
      preview: z.boolean().optional(),
      name: z.string().optional(),
    }),
    kind: "edit",
    label: (a) => (a.preview ? "Preview 3D render" : "Render 3D model"),
    async run(input, aseprite) {
      const model = loadModel(input.path);
      const size = input.size ?? 32;
      const n = input.directions ?? 8;
      const elev = typeof input.elevation === "number" ? input.elevation : ELEVATIONS[input.elevation ?? "three-quarter"];
      const names = directionNames(input.preview ? 1 : n);
      const views: View[] = names.map((_, i) => ({ azimuth: (i * 360) / n, elevation: elev }));
      const fps = input.fps ?? 10;
      const wanted = input.animation === "none" ? [] : input.animation && input.animation !== "all"
        ? model.clips.filter((c) => c.name === input.animation) : model.clips;
      if (input.animation && !["all", "none"].includes(input.animation) && !wanted.length) {
        return failure(`No clip named ${input.animation}. Clips: ${model.clips.map((c) => c.name).join(", ") || "none"}.`);
      }
      // Times per clip (or the rest pose).
      const clips = wanted.length
        ? wanted.map((c) => ({ name: c.name, times: Array.from({ length: Math.max(1, Math.round(c.duration * fps)) }, (_, i) => i / fps) }))
        : [{ name: "", times: [0] }];
      const poses = clips.map((c) => c.times.map((t) => model.triangles(c.name || undefined, t)));
      const fit = fitFrame(poses.flat(), views);
      let palette: RGBA[] | undefined;
      if (input.palette && input.palette !== "none") {
        palette = input.palette === "sprite" ? (await spriteInfo(aseprite)).palette : findPalette(input.palette)?.colors;
        if (!palette?.length) return failure(`No palette ${input.palette}.`);
      }
      const finish = (data: Uint8Array): Rgba => {
        let img: Rgba = { width: size, height: size, data };
        if (palette) img = snap(img, palette);
        if ((input.outline ?? "darkest") !== "none") img = outline(img, { color: input.outline ?? "darkest", palette });
        return img;
      };
      if (input.preview) {
        const img = finish(renderView(poses[0][0], views[0], fit, { size, bands: input.bands }));
        const png = encodeSnapshot(Buffer.from(img.data), size, size, Math.max(1, Math.floor(256 / size)), "checker");
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, text(`Preview: ${size}x${size}, facing S, elevation ${elev}°.${model.notes.length ? " " + model.notes.join(" ") : ""}`)] };
      }
      const frames: { rgba: string; duration: number }[] = [];
      const tags: { name: string; from: number; to: number }[] = [];
      for (let ci = 0; ci < clips.length; ci++) {
        for (let di = 0; di < views.length; di++) {
          const from = frames.length + 1;
          for (const tris of poses[ci]) {
            const img = finish(renderView(tris, views[di], fit, { size, bands: input.bands }));
            frames.push({ rgba: Buffer.from(img.data).toString("base64"), duration: Math.round(1000 / fps) });
          }
          tags.push({ name: clips[ci].name ? `${clips[ci].name}_${names[di]}` : names[di], from, to: frames.length });
        }
      }
      const colors = new Set<string>();
      for (const f of frames) {
        const d = Buffer.from(f.rgba, "base64");
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) colors.add(hex({ r: d[i], g: d[i + 1], b: d[i + 2], a: 255 }));
      }
      const r = await aseprite.request("create_animation", {
        width: size, height: size, title: input.name ?? "3D render", frames, tags, palette: palette ? palette.map(hex) : [...colors].slice(0, 256),
      }, 120_000);
      return { content: [text(`Rendered "${r.result.title}": ${frames.length} frames of ${size}x${size} — ${views.length} direction(s)` +
        `${wanted.length ? ` x ${clips.map((c) => `${c.name} (${c.times.length} frames)`).join(", ")}` : ""}, elevation ${elev}°, ${colors.size} colors. ` +
        `Tags: ${tags.slice(0, 8).map((t) => t.name).join(", ")}${tags.length > 8 ? ", …" : ""}.${model.notes.length ? " " + model.notes.join(" ") : ""}`)] };
    },
  },
];
