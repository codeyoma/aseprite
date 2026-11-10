// Pixel text and UI elements as tools (#50).
import * as z from "zod/v4";
import { adjust, nearest, parseHex, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";
import { spriteInfo } from "./shading_tools.js";
import { loadFont, measureText, panel, renderText, stamp, type PanelStyle } from "./ui.js";
import { failure, text, type Tool, type ToolResult } from "./tool.js";

const send = (img: Rgba) => Buffer.from(img.data).toString("base64");
const rgb = (h: string | undefined): [number, number, number] | undefined => {
  const c = h ? parseHex(h) : undefined;
  return c ? [c.r, c.g, c.b] : undefined;
};
const asRgb = (c: RGBA): [number, number, number] => [c.r, c.g, c.b];

/** Snaps every opaque pixel (base64 RGBA) to the nearest palette color. */
function snapAll(b64: string, palette: RGBA[]): string {
  const d = Buffer.from(b64, "base64");
  const memo = new Map<number, RGBA>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let c = memo.get(k);
    if (!c) {
      c = nearest({ r: d[i], g: d[i + 1], b: d[i + 2], a: 255 }, palette).color;
      memo.set(k, c);
    }
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
  }
  return d.toString("base64");
}

export const UI_TOOLS: Tool[] = [
  {
    name: "draw_text",
    title: "Draw pixel text",
    description:
      "Draw text with Aseprite's pixel fonts ('aseprite' 7 px tall, or 'mini' 5 px), pixel-exact with no " +
      "anti-aliasing, optionally with a 1 px outline and a drop shadow, at an integer scale. Lines split on \\n. " +
      "Drawn on an 'AI: text' layer at x, y.",
    input: z.object({
      text: z.string().min(1),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      color: z.string().describe("e.g. '#fff1e8'"),
      outline: z.string().optional(),
      shadow: z.string().optional(),
      font: z.enum(["aseprite", "mini"]).optional(),
      scale: z.number().int().min(1).max(8).optional(),
      align: z.enum(["left", "center"]).optional().describe("'center' centers on x."),
      frame: z.number().int().min(1).optional(),
    }),
    kind: "edit",
    label: (a) => (a.text ? `Draw text "${String(a.text).slice(0, 20)}"` : "Draw text"),
    async run(input, aseprite) {
      const color = rgb(input.color);
      if (!color) return failure(`Not a color: ${input.color}`);
      const font = loadFont(input.font ?? "aseprite");
      const img = renderText(input.text, font, { color, outline: rgb(input.outline), shadow: rgb(input.shadow), scale: input.scale });
      const info = await spriteInfo(aseprite);
      const { result } = await aseprite.request("execute_lua", { code: "return { w = app.sprite.width, h = app.sprite.height }", transaction: false });
      const W = result.value.w, H = result.value.h;
      const x = (input.x ?? 0) - (input.align === "center" ? Math.floor(img.width / 2) : 0), y = input.y ?? 0;
      const canvas = stamp({ width: W, height: H, data: new Uint8Array(W * H * 4) }, img, x, y);
      await aseprite.request("put_image", { new_layer: "text", frame: input.frame ?? info.frame, width: W, height: H, rgba: send(canvas) });
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
      let frames: { rgba: string; duration: number }[], tags: { name: string; from: number; to: number }[] = [], center;
      if (input.kind === "panel") {
        const p = face(fillC);
        frames = [{ rgba: send(p.image), duration: 100 }];
        center = p.center;
      } else {
        const states = [
          face(fillC),
          face(adjust(fillC, { lightness: 0.08 })),
          face(adjust(fillC, { lightness: -0.06 }), { pressed: true }),
          face(adjust(fillC, { chroma: -0.85, lightness: -0.05 }), { disabled: true }),
        ];
        frames = states.map((s) => ({ rgba: send(s.image), duration: 100 }));
        tags = ["normal", "hover", "pressed", "disabled"].map((n, i) => ({ name: n, from: i + 1, to: i + 1 }));
        center = states[0].center;
      }
      if (input.snap_to_palette !== false) {
        const pal = (await spriteInfo(aseprite).catch(() => ({ palette: [] as RGBA[] }))).palette;
        if (pal.length >= 2) frames = frames.map((f) => ({ ...f, rgba: snapAll(f.rgba, pal) }));
      }
      const made = await aseprite.request("create_animation", { width: input.width, height: input.height, title: name, frames, tags });
      await aseprite.request("set_slice", { name, x: 0, y: 0, w: input.width, h: input.height, center });
      return { content: [text(`Made "${made.result.title}": a ${input.width}x${input.height} ${input.kind}${input.kind === "button" ? " with normal, hover, pressed and disabled frames" : ""}, ` +
        `and a 9-patch slice '${name}' (stretchable center ${center.w}x${center.h} at ${center.x},${center.y}).`)] };
    },
  },
];
