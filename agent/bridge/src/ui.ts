// Pixel text and UI elements (#50). Text uses Aseprite's own bitmap fonts
// (data/fonts/aseprite_font.png and aseprite_mini.png, CC BY 4.0), read
// the way Aseprite reads sprite-sheet fonts: glyph cells separated by the
// key color at (0, 0), in codepoint order from ' '.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { repoRoot } from "./developer.js";
import type { Rgba } from "./pixel_grid.js";

export interface BitmapFont {
  sheet: Rgba;
  glyphs: ({ x: number; y: number; w: number; h: number } | undefined)[];
  height: number;
}

export function fontDirs(): string[] {
  const root = repoRoot();
  return [
    root && join(root, "data", "fonts"),
    "/Applications/Aseprite.app/Contents/Resources/data/fonts",
    process.env.ASEPRITE_DATA && join(process.env.ASEPRITE_DATA, "fonts"),
  ].filter((d): d is string => !!d && existsSync(d));
}

const px = (img: Rgba, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return ((img.data[i] << 24) | (img.data[i + 1] << 16) | (img.data[i + 2] << 8) | img.data[i + 3]) >>> 0;
};

/** Parses a sprite-sheet font (the same scan as laf's SpriteSheetTypeface). */
export function parseFont(sheet: Rgba): BitmapFont {
  const key = px(sheet, 0, 0);
  const glyphs: BitmapFont["glyphs"] = [undefined, undefined]; // 0: missing, 1: null
  let bx = 0, by = 0, bh = 1;
  for (;;) {
    while (px(sheet, bx, by) === key) {
      bx++;
      if (bx >= sheet.width) {
        bx = 0;
        by += bh;
        bh = 1;
        if (by >= sheet.height) return { sheet, glyphs, height: glyphs[2]?.h ?? 0 };
      }
    }
    const first = px(sheet, bx, by);
    let w = 0, h = 0;
    while (bx + w < sheet.width && px(sheet, bx + w, by) !== key) w++;
    while (by + h < sheet.height && px(sheet, bx, by + h) !== key) h++;
    glyphs.push(first === 0xff0000ff ? undefined : { x: bx, y: by, w, h });
    bh = h;
    bx += w;
  }
}

const cache = new Map<string, BitmapFont>();
export function loadFont(name: "aseprite" | "mini" = "aseprite"): BitmapFont {
  const hit = cache.get(name);
  if (hit) return hit;
  const file = name === "mini" ? "aseprite_mini.png" : "aseprite_font.png";
  const dir = fontDirs().find((d) => existsSync(join(d, file)));
  if (!dir) throw new Error(`Aseprite's ${file} wasn't found (set ASEPRITE_DATA to Aseprite's data folder)`);
  const png = PNG.sync.read(readFileSync(join(dir, file)));
  const font = parseFont({ width: png.width, height: png.height, data: png.data });
  cache.set(name, font);
  return font;
}

function glyphFor(font: BitmapFont, ch: string) {
  const cp = ch.codePointAt(0) ?? 32;
  return font.glyphs[cp - 32 + 2] ?? font.glyphs[128 - 32 + 2] ?? font.glyphs[2];
}

export function measureText(text: string, font: BitmapFont): { width: number; height: number } {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => [...l].reduce((w, ch) => w + (glyphFor(font, ch)?.w ?? 0), 0)));
  return { width, height: lines.length * font.height };
}

export interface TextStyle {
  color: [number, number, number];
  outline?: [number, number, number];
  shadow?: [number, number, number];
  scale?: number;
}

/** Text as a pixel-exact image (only the given colors, no anti-aliasing). */
export function renderText(text: string, font: BitmapFont, style: TextStyle): Rgba {
  const m = measureText(text, font);
  const pad = style.outline ? 1 : 0;
  const sh = style.shadow ? 1 : 0;
  const W = m.width + pad * 2 + sh, H = m.height + pad * 2 + sh;
  const ink = new Uint8Array(W * H);
  let y0 = pad;
  for (const line of text.split("\n")) {
    let x0 = pad;
    for (const ch of line) {
      const g = glyphFor(font, ch);
      if (!g) continue;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const i = ((g.y + y) * font.sheet.width + g.x + x) * 4;
        if (font.sheet.data[i + 3] === 255 && font.sheet.data[i] < 128) ink[(y0 + y) * W + x0 + x] = 1;
      }
      x0 += g.w;
    }
    y0 += font.height;
  }
  const out = new Uint8Array(W * H * 4);
  const set = (x: number, y: number, c: [number, number, number]) => out.set([...c, 255], (y * W + x) * 4);
  const has = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x] === 1;
  if (style.shadow) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (has(x - 1, y - 1)) set(x, y, style.shadow);
  if (style.outline) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!has(x, y) && (has(x - 1, y) || has(x + 1, y) || has(x, y - 1) || has(x, y + 1))) set(x, y, style.outline);
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (has(x, y)) set(x, y, style.color);
  return scale(trimTo(out, W, H), style.scale ?? 1);
}

function trimTo(data: Uint8Array, W: number, H: number): Rgba {
  return { width: W, height: H, data };
}

export function scale(img: Rgba, s: number): Rgba {
  if (s <= 1) return img;
  const w = img.width * s, h = img.height * s, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 4;
    out.set(img.data.subarray(i, i + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

export interface PanelStyle {
  fill: [number, number, number];
  border: [number, number, number];
  highlight?: [number, number, number];
  shadow?: [number, number, number];
  /** Corner rounding: 0 square, 1 one pixel cut, 2 rounder. */
  radius?: number;
}

/**
 * A UI panel or button face: a 1 px border, an inner highlight on the top
 * and left, an inner shadow on the bottom and right, rounded corners. The
 * 9-slice center is everything inside the border, highlight and shadow.
 */
export function panel(w: number, h: number, s: PanelStyle): { image: Rgba; center: { x: number; y: number; w: number; h: number } } {
  const out = new Uint8Array(w * h * 4);
  const r = s.radius ?? 1;
  const cut = (x: number, y: number) => {
    const dx = Math.min(x, w - 1 - x), dy = Math.min(y, h - 1 - y);
    return dx + dy < r;
  };
  const border = (x: number, y: number) => {
    if (cut(x, y)) return false;
    return x === 0 || y === 0 || x === w - 1 || y === h - 1 || cut(x - 1, y) || cut(x + 1, y) || cut(x, y - 1) || cut(x, y + 1);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (cut(x, y)) continue;
    let c = s.fill;
    if (border(x, y)) c = s.border;
    else if (s.highlight && (y === 1 || x === 1)) c = s.highlight;
    else if (s.shadow && (y === h - 2 || x === w - 2)) c = s.shadow;
    out.set([...c, 255], (y * w + x) * 4);
  }
  const inset = 2 + Math.max(0, r - 1);
  return { image: { width: w, height: h, data: out }, center: { x: inset, y: inset, w: Math.max(1, w - inset * 2), h: Math.max(1, h - inset * 2) } };
}

/** Composites `top` onto `base` at (x, y) (opaque pixels only). */
export function stamp(base: Rgba, top: Rgba, x: number, y: number): Rgba {
  const out = new Uint8Array(base.data);
  for (let yy = 0; yy < top.height; yy++) for (let xx = 0; xx < top.width; xx++) {
    const i = (yy * top.width + xx) * 4;
    const X = x + xx, Y = y + yy;
    if (top.data[i + 3] < 128 || X < 0 || Y < 0 || X >= base.width || Y >= base.height) continue;
    out.set(top.data.subarray(i, i + 4), (Y * base.width + X) * 4);
  }
  return { width: base.width, height: base.height, data: out };
}
