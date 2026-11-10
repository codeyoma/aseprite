// Pixel text and UI elements as tools (#50).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod/v4";
import { adjust, parseHex, type RGBA } from "./color.js";
import { documentOf, type AnimationFrame } from "./document.js";
import { blank, readPng, snapToPalette, stamp, type Rgba } from "./image.js";
import { NOT_PNG_SHEET } from "./sheet_tools.js";
import { bitmapInk, bmfontInk, imageInk, loadFont, measureText, panel, parseBMFont, renderText, styleInk, type Ink, type PanelStyle } from "./ui.js";
import { resolvePalette } from "./tool_inputs.js";
import { failure, text, type Tool } from "./tool.js";

const rgb = (h: string | undefined): [number, number, number] | undefined => {
  const c = h ? parseHex(h) : undefined;
  return c ? [c.r, c.g, c.b] : undefined;
};
const asRgb = (c: RGBA): [number, number, number] => [c.r, c.g, c.b];

export const UI_TOOLS: Tool[] = [
  {
    name: "draw_text",
    title: "Draw pixel text",
    description:
      "Draw text pixel-exact with no anti-aliasing, optionally with a 1 px outline and a drop shadow, at an integer " +
      "scale. Fonts: Aseprite's pixel fonts ('aseprite' 7 px tall, 'mini' 5 px), a BMFont (.fnt path, with its page " +
      "PNGs next to it), a TrueType/OpenType file (.ttf/.otf path, at `size` px; pixel fonts look best at their design " +
      "size), or an installed font by name ('system:Arial'). Lines split on \\n. Drawn on an 'AI: text' layer at x, y.",
    input: z.object({
      text: z.string().min(1),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      color: z.string().describe("e.g. '#fff1e8'"),
      outline: z.string().optional(),
      shadow: z.string().optional(),
      font: z.string().optional().describe("'aseprite' (default), 'mini', a .fnt or .ttf/.otf path, or 'system:<name>'."),
      size: z.number().min(4).max(128).optional().describe("Font size in px for TTF/OTF and system fonts. Default 8."),
      scale: z.number().int().min(1).max(8).optional(),
      align: z.enum(["left", "center"]).optional().describe("'center' centers on x."),
      frame: z.number().int().min(1).optional(),
    }),
    kind: "edit",
    label: (a) => (a.text ? `Draw text "${String(a.text).slice(0, 20)}"` : "Draw text"),
    async run(input, aseprite) {
      const color = rgb(input.color);
      if (!color) return failure(`Not a color: ${input.color}`);
      const doc = documentOf(aseprite);
      const font = input.font ?? "aseprite";
      let ink: Ink;
      if (font === "aseprite" || font === "mini") ink = bitmapInk(input.text, loadFont(font));
      else if (/\.fnt$/i.test(font)) {
        if (!existsSync(font)) return failure(`No font file at ${font}`);
        ink = bmfontInk(input.text, parseBMFont(readFileSync(font, "utf8"), (file) => readPng(join(dirname(font), file), NOT_PNG_SHEET)));
      } else if (/\.(ttf|otf|ttc)$/i.test(font)) {
        if (!existsSync(font)) return failure(`No font file at ${font}`);
        ink = imageInk(await doc.renderFontText(input.text, `file=${font}`, input.size ?? 8));
      } else ink = imageInk(await doc.renderFontText(input.text, `system=${font.replace(/^system:/, "")}`, input.size ?? 8));
      const img = styleInk(ink, { color, outline: rgb(input.outline), shadow: rgb(input.shadow), scale: input.scale });
      const info = await doc.info();
      const W = info.width, H = info.height;
      const x = (input.x ?? 0) - (input.align === "center" ? Math.floor(img.width / 2) : 0), y = input.y ?? 0;
      const canvas = stamp(blank(W, H), img, x, y);
      await doc.putImage(canvas, { newLayer: "text", frame: input.frame ?? info.frame });
      const clipped = x < 0 || y < 0 || x + img.width > W || y + img.height > H;
      return { content: [text(`Drew "${input.text}" (${img.width}x${img.height} px) at ${x},${y} on 'AI: text'.${clipped ? " Part of it is outside the canvas." : ""}`)] };
    },
  },
  {
    name: "make_ui",
    title: "Make UI element",
    description:
      "Make a pixel UI element as a new sprite with a 9-patch slice (so engines can stretch it): 'panel' (a framed " +
      "box) or 'button' (4 frames tagged normal, hover, pressed, disabled, with a centered label). Style: fill, border, " +
      "highlight and shadow colors (highlight/shadow default to lighter/darker fill), corner radius 0-2.",
    input: z.object({
      kind: z.enum(["panel", "button"]),
      width: z.number().int().min(6).max(512),
      height: z.number().int().min(6).max(512),
      fill: z.string(),
      border: z.string().optional().describe("Default: a dark version of the fill."),
      highlight: z.string().optional(),
      shadow: z.string().optional(),
      radius: z.number().int().min(0).max(2).optional(),
      label: z.string().optional(),
      label_color: z.string().optional(),
      font: z.enum(["aseprite", "mini"]).optional(),
      name: z.string().optional(),
      snap_to_palette: z.boolean().optional().describe("Snap every color (including hover/disabled shades) to the sprite palette. Default true."),
    }),
    kind: "edit",
    label: (a) => `Make ${a.kind ?? "UI"}`,
    async run(input, aseprite) {
      const fillC = parseHex(input.fill);
      if (!fillC) return failure(`Not a color: ${input.fill}`);
      const style = (fill: RGBA): PanelStyle => ({
        fill: asRgb(fill),
        border: rgb(input.border) ?? asRgb(adjust(fill, { lightness: -0.45, chroma: -0.3 })),
        highlight: rgb(input.highlight) ?? asRgb(adjust(fill, { lightness: 0.12 })),
        shadow: rgb(input.shadow) ?? asRgb(adjust(fill, { lightness: -0.12 })),
        radius: input.radius ?? 1,
      });
      const font = loadFont(input.font ?? "aseprite");
      const labelColor = rgb(input.label_color) ?? [255, 241, 232];
      const face = (fill: RGBA, opts: { pressed?: boolean; disabled?: boolean } = {}): { image: Rgba; center: { x: number; y: number; w: number; h: number } } => {
        const st = style(fill);
        if (opts.pressed) [st.highlight, st.shadow] = [st.shadow, st.highlight];
        const p = panel(input.width, input.height, st);
        if (!input.label) return p;
        const tc: [number, number, number] = opts.disabled ? [150, 150, 158] : labelColor;
        const t = renderText(input.label, font, { color: tc, shadow: opts.disabled ? undefined : st.shadow });
        const m = measureText(input.label, font);
        const x = Math.floor((input.width - m.width) / 2), y = Math.floor((input.height - m.height) / 2) + (opts.pressed ? 1 : 0);
        return { image: stamp(p.image, t, x, y), center: p.center };
      };
      const name = input.name ?? input.kind;
      let frames: AnimationFrame[], tags: { name: string; from: number; to: number }[] = [], center;
      if (input.kind === "panel") {
        const p = face(fillC);
        frames = [{ image: p.image, duration: 100 }];
        center = p.center;
      } else {
        const states = [
          face(fillC),
          face(adjust(fillC, { lightness: 0.08 })),
          face(adjust(fillC, { lightness: -0.06 }), { pressed: true }),
          face(adjust(fillC, { chroma: -0.85, lightness: -0.05 }), { disabled: true }),
        ];
        frames = states.map((s) => ({ image: s.image, duration: 100 }));
        tags = ["normal", "hover", "pressed", "disabled"].map((n, i) => ({ name: n, from: i + 1, to: i + 1 }));
        center = states[0].center;
      }
      const doc = documentOf(aseprite);
      if (input.snap_to_palette !== false) {
        // No sprite open: nothing to snap to.
        const pal = (await resolvePalette("sprite", doc).catch(() => undefined)) ?? [];
        if (pal.length >= 2) frames = frames.map((f) => ({ ...f, image: snapToPalette(f.image, pal) }));
      }
      const made = await doc.createAnimation(input.width, input.height, frames, { title: name, tags });
      await doc.setSlice({ name, x: 0, y: 0, w: input.width, h: input.height, center });
      return { content: [text(`Made "${made.title}": a ${input.width}x${input.height} ${input.kind}${input.kind === "button" ? " with normal, hover, pressed and disabled frames" : ""}, ` +
        `and a 9-patch slice '${name}' (stretchable center ${center.w}x${center.h} at ${center.x},${center.y}).`)] };
    },
  },
];
