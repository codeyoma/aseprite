// Pixel text and UI elements (#50). Text uses Aseprite's own bitmap fonts
// (data/fonts/aseprite_font.png and aseprite_mini.png, CC BY 4.0), read
// the way Aseprite reads sprite-sheet fonts: glyph cells separated by the
// key color at (0, 0), in codepoint order from ' '.
import { installedAsepriteData } from "./platform.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./developer.js";
import { OPAQUE, readPng, scale, type Rgba } from "./image.js";

export interface BitmapFont {
  sheet: Rgba;
  glyphs: ({ x: number; y: number; w: number; h: number } | undefined)[];
  height: number;
}

export function fontDirs(): string[] {
  const root = repoRoot();
  return [
    root && join(root, "data", "fonts"),
    ...installedAsepriteData().map((d) => join(d, "fonts")),
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
  const font = parseFont(readPng(join(dir, file)));
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

/** Where text's pixels are: 1 = ink, at its size (no padding). */
export interface Ink {
  width: number;
  height: number;
  ink: Uint8Array;
}

/** The ink of text in one of Aseprite's sprite-sheet fonts. */
export function bitmapInk(text: string, font: BitmapFont): Ink {
  const m = measureText(text, font);
  const W = m.width, H = m.height, ink = new Uint8Array(W * H);
  let y0 = 0;
  for (const line of text.split("\n")) {
    let x0 = 0;
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
  return { width: W, height: H, ink };
}

/** The ink of an image: its opaque pixels (text Aseprite rendered from a TTF). */
export function imageInk(img: Rgba): Ink {
  const ink = new Uint8Array(img.width * img.height);
  for (let i = 0; i < ink.length; i++) ink[i] = img.data[i * 4 + 3] >= OPAQUE ? 1 : 0;
  return { width: img.width, height: img.height, ink };
}

// ---------------------------------------------------------------------------
// BMFont (AngelCode .fnt, text or XML) with its page images
// ---------------------------------------------------------------------------

export interface BMFont {
  lineHeight: number;
  pages: Rgba[];
  chars: Map<number, { x: number; y: number; w: number; h: number; xo: number; yo: number; xa: number; page: number }>;
  kerning: Map<string, number>;
}

const kv = (line: string) => Object.fromEntries([...line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)].map((m) => [m[1], m[3] ?? m[2]]));

/** Parses a .fnt (text or XML); page(file) loads a page image. */
export function parseBMFont(fnt: string, page: (file: string) => Rgba): BMFont {
  const xml = fnt.trimStart().startsWith("<");
  const entries = xml
    ? [...fnt.matchAll(/<(common|page|char|kerning)\b([^>]*)\/?>/g)].map((m) => [m[1], kv(m[2])] as const)
    : fnt.split(/\r?\n/).map((l) => /^(\w+)\s+(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m![1], kv(m![2])] as const);
  let lineHeight = 0;
  const files: string[] = [];
  const chars: BMFont["chars"] = new Map(), kerning = new Map<string, number>();
  for (const [kind, a] of entries) {
    if (kind === "common") lineHeight = Number(a.lineHeight);
    else if (kind === "page") files[Number(a.id)] = a.file;
    else if (kind === "char") {
      chars.set(Number(a.id), { x: +a.x, y: +a.y, w: +a.width, h: +a.height, xo: +a.xoffset, yo: +a.yoffset, xa: +a.xadvance, page: +(a.page ?? 0) });
    } else if (kind === "kerning") kerning.set(`${a.first},${a.second}`, Number(a.amount));
  }
  if (!chars.size || !lineHeight) throw new Error("Not a BMFont .fnt: no common line or no chars");
  return { lineHeight, pages: files.map((f) => page(f)), chars, kerning };
}

/** The ink of text in a BMFont: glyph pixels with alpha at least 128. */
export function bmfontInk(text: string, font: BMFont): Ink {
  const lines = text.split("\n");
  const missing = font.chars.get(63) ?? font.chars.get(32); // "?" stands in for a missing glyph
  type Placed = { g: NonNullable<typeof missing>; x: number; y: number };
  const placed: Placed[] = [];
  let W = 0;
  lines.forEach((line, row) => {
    let x = 0, prev = -1;
    for (const ch of line) {
      const cp = ch.codePointAt(0)!;
      const g = font.chars.get(cp) ?? missing;
      if (!g) continue;
      x += prev >= 0 ? font.kerning.get(`${prev},${cp}`) ?? 0 : 0;
      placed.push({ g, x: x + g.xo, y: row * font.lineHeight + g.yo });
      W = Math.max(W, x + g.xo + g.w, x + g.xa);
      x += g.xa;
      prev = cp;
    }
  });
  const H = lines.length * font.lineHeight, ink = new Uint8Array(Math.max(1, W) * H);
  for (const { g, x, y } of placed) {
    const page = font.pages[g.page];
    for (let yy = 0; yy < g.h; yy++) for (let xx = 0; xx < g.w; xx++) {
      const tx = x + xx, ty = y + yy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      if (page.data[((g.y + yy) * page.width + g.x + xx) * 4 + 3] >= OPAQUE) ink[ty * W + tx] = 1;
    }
  }
  return { width: Math.max(1, W), height: H, ink };
}

/** Text as a pixel-exact image (only the given colors, no anti-aliasing). */
export function renderText(text: string, font: BitmapFont, style: TextStyle): Rgba {
  return styleInk(bitmapInk(text, font), style);
}

/** Colors ink with an optional 1 px outline and drop shadow, at an integer scale. */
export function styleInk(src: Ink, style: TextStyle): Rgba {
  const pad = style.outline ? 1 : 0;
  const sh = style.shadow ? 1 : 0;
  const W = src.width + pad * 2 + sh, H = src.height + pad * 2 + sh;
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) ink[(y + pad) * W + x + pad] = src.ink[y * src.width + x];
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
