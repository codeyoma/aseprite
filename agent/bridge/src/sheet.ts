// Sprite sheet slicing (#41) and sprite finding (shared with #40): cut a
// sheet into frames by a grid (given, or found from empty gutters), by
// the sprites on it (connected regions on a background), or by an atlas
// (Aseprite / TexturePacker JSON or XML, Godot SpriteFrames).
import type { Rgba } from "./pixel_grid.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  rect: Rect;
  /** Where the rect sits inside the frame canvas (trimmed atlas frames). */
  offsetX?: number;
  offsetY?: number;
  duration?: number; // ms
  row?: number;
}

export interface Tag {
  name: string;
  from: number; // 1-based
  to: number;
  direction?: string;
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

/** The background: transparent, or the most common color on the border (a key color). */
export function detectBackground(img: Rgba): { transparent: boolean; color?: [number, number, number] } {
  const { width: w, height: h, data } = img;
  const counts = new Map<number, number>();
  let transparent = 0, border = 0;
  const see = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    border++;
    if (data[i + 3] < 128) {
      transparent++;
      return;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < w; x++) {
    see(x, 0);
    see(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    see(0, y);
    see(w - 1, y);
  }
  if (transparent >= border / 2) return { transparent: true };
  let best = 0, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return { transparent: false, color: [(best >> 16) & 255, (best >> 8) & 255, best & 255] };
}

/** A copy with the background made transparent (exact key color, within `tolerance` per channel). */
export function removeBackground(img: Rgba, tolerance = 8): Rgba {
  const bg = detectBackground(img);
  if (bg.transparent || !bg.color) return img;
  const d = new Uint8Array(img.data);
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - bg.color[0]) <= tolerance && Math.abs(d[i + 1] - bg.color[1]) <= tolerance && Math.abs(d[i + 2] - bg.color[2]) <= tolerance) {
      d[i + 3] = 0;
    }
  }
  return { ...img, data: d };
}

const opaque = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3] >= 128;

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** Runs of non-empty columns (or rows): [start, end) spans separated by empty gutters. */
function spans(img: Rgba, axis: "x" | "y"): [number, number][] {
  const n = axis === "x" ? img.width : img.height;
  const m = axis === "x" ? img.height : img.width;
  const filled: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let any = false;
    for (let j = 0; j < m && !any; j++) any = axis === "x" ? opaque(img, i, j) : opaque(img, j, i);
    filled.push(any);
  }
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && filled[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  return out;
}

/**
 * The cell size of a regular sheet, from the empty gutters between
 * sprites: the most common distance between sprite centers (sprites of
 * different widths drawn centered in their cells still line up), and the
 * smallest margin that keeps every cell boundary in a gutter.
 */
export function detectCells(img: Rgba): { cellW: number; cellH: number; marginX: number; marginY: number } | undefined {
  const axis = (dir: "x" | "y", size: number) => {
    const s = spans(img, dir);
    if (s.length < 2) return { pitch: size, margin: 0 };
    const centers = s.map(([a, b]) => (a + b) / 2);
    const d = new Map<number, number>();
    for (let i = 1; i < centers.length; i++) {
      const k = Math.round(centers[i] - centers[i - 1]);
      d.set(k, (d.get(k) ?? 0) + 1);
    }
    const pitch = [...d].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    // The smallest margin whose cell boundaries all fall in empty gutters
    // (sprites may sit anywhere in their cells, e.g. on the bottom line).
    const inSprite = (i: number) => s.some(([a, b]) => i > a && i < b);
    for (let m = 0; m < pitch; m++) {
      let ok = true;
      for (let i = m; i < size && ok; i += pitch) ok = !inSprite(i);
      if (ok) return { pitch, margin: m };
    }
    return { pitch, margin: (((Math.round(centers[0] - pitch / 2)) % pitch) + pitch) % pitch };
  };
  const x = axis("x", img.width), y = axis("y", img.height);
  if (x.pitch >= img.width && y.pitch >= img.height) return undefined;
  return { cellW: x.pitch, cellH: y.pitch, marginX: x.margin, marginY: y.margin };
}

export interface GridOptions {
  cellW: number;
  cellH: number;
  marginX?: number;
  marginY?: number;
  paddingX?: number; // space between cells
  paddingY?: number;
  order?: "rows" | "columns";
  skipEmpty?: boolean;
}

export function gridFrames(img: Rgba, o: GridOptions): Frame[] {
  const mx = o.marginX ?? 0, my = o.marginY ?? 0, px = o.paddingX ?? 0, py = o.paddingY ?? 0;
  const cols = Math.floor((img.width - mx + px) / (o.cellW + px));
  const rows = Math.floor((img.height - my + py) / (o.cellH + py));
  const cells: Frame[] = [];
  const add = (r: number, c: number) => {
    const rect = { x: mx + c * (o.cellW + px), y: my + r * (o.cellH + py), w: o.cellW, h: o.cellH };
    if (o.skipEmpty !== false && isEmpty(img, rect)) return;
    cells.push({ rect, row: r });
  };
  if (o.order === "columns") for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) add(r, c);
  else for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) add(r, c);
  return cells;
}

function isEmpty(img: Rgba, r: Rect): boolean {
  for (let y = r.y; y < r.y + r.h && y < img.height; y++) {
    for (let x = r.x; x < r.x + r.w && x < img.width; x++) if (opaque(img, x, y)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sprites (connected regions)
// ---------------------------------------------------------------------------

/**
 * Bounding boxes of the sprites on a sheet: 8-connected opaque regions,
 * merged when closer than `mergeDistance` px (a sword apart from its
 * hand, an effect pixel), in reading order (rows by vertical overlap,
 * then left to right). Specks smaller than `minPixels` are dropped.
 */
export function findSprites(img: Rgba, mergeDistance = 2, minPixels = 4): Frame[] {
  const { width: w, height: h } = img;
  const label = new Int32Array(w * h).fill(-1);
  const boxes: (Rect & { n: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] >= 0 || img.data[start * 4 + 3] < 128) continue;
    const id = boxes.length;
    const b = { x: w, y: h, w: 0, h: 0, n: 0, x1: -1, y1: -1 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      b.n++;
      if (x < b.x) b.x = x;
      if (y < b.y) b.y = y;
      if (x > b.x1) b.x1 = x;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (label[q] < 0 && img.data[q * 4 + 3] >= 128) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    boxes.push({ x: b.x, y: b.y, w: b.x1 - b.x + 1, h: b.y1 - b.y + 1, n: b.n });
  }
  // Merge boxes closer than mergeDistance until nothing changes.
  let merged = boxes.slice();
  let changed = true;
  const near = (a: Rect, b: Rect) =>
    a.x - mergeDistance <= b.x + b.w && b.x - mergeDistance <= a.x + a.w && a.y - mergeDistance <= b.y + b.h && b.y - mergeDistance <= a.y + a.h;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        if (near(merged[i], merged[j])) {
          const a = merged[i], b = merged[j];
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          merged[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, n: a.n + b.n };
          merged.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  merged = merged.filter((b) => b.n >= minPixels);
  // Reading order: group into rows by vertical overlap, then by x.
  merged.sort((a, b) => a.y - b.y);
  const rows: (Rect & { n: number })[][] = [];
  for (const b of merged) {
    const row = rows.find((r) => r.some((o) => b.y < o.y + o.h && o.y < b.y + b.h));
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r, ri) => r.sort((a, b) => a.x - b.x).map(({ x, y, w, h }) => ({ rect: { x, y, w, h }, row: ri })));
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/**
 * Frames and tags from an atlas: Aseprite's JSON (hash or array) and
 * TexturePacker JSON (same shape). Trimmed frames keep their position in
 * the original size (spriteSourceSize/sourceSize).
 */
export function parseAtlas(json: any): { frames: Frame[]; tags: Tag[]; width?: number; height?: number } {
  const list: any[] = Array.isArray(json.frames)
    ? json.frames
    : Object.entries(json.frames ?? {}).map(([filename, f]: [string, any]) => ({ filename, ...f }));
  if (!list.length) throw new Error("The atlas has no frames");
  let width: number | undefined, height: number | undefined;
  const frames = list.map((f) => {
    const r = f.frame;
    if (f.rotated) throw new Error(`Frame ${f.filename ?? ""} is rotated in the atlas; rotated frames aren't supported`);
    const src = f.sourceSize ?? { w: r.w, h: r.h };
    width = Math.max(width ?? 0, src.w);
    height = Math.max(height ?? 0, src.h);
    return {
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      offsetX: f.spriteSourceSize?.x ?? 0,
      offsetY: f.spriteSourceSize?.y ?? 0,
      duration: f.duration,
    } as Frame;
  });
  const tags: Tag[] = (json.meta?.frameTags ?? []).map((t: any) => ({
    name: t.name, from: t.from + 1, to: t.to + 1, direction: t.direction,
  }));
  return { frames, tags, width, height };
}

type Atlas = { frames: Frame[]; tags: Tag[]; width?: number; height?: number };

const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

/**
 * TexturePacker XML: the Sparrow/Starling format (<SubTexture name x y width
 * height frameX frameY frameWidth frameHeight/>, frameX/Y negative for
 * trimmed frames) or the generic one (<sprite n x y w h oX oY oW oH/>).
 */
export function parseAtlasXml(xml: string): Atlas {
  const frames: Frame[] = [];
  let width: number | undefined, height: number | undefined;
  for (const m of xml.matchAll(/<(SubTexture|sprite)\b([^>]*)\/?>/g)) {
    const a = attrs(m[2]);
    const sparrow = m[1] === "SubTexture";
    const rot = sparrow ? a.rotated === "true" : a.r === "y";
    if (rot) throw new Error(`Frame ${a.name ?? a.n ?? ""} is rotated in the atlas; rotated frames aren't supported`);
    const n = (k: string) => (a[k] === undefined ? undefined : Number(a[k]));
    const rect = sparrow ? { x: n("x")!, y: n("y")!, w: n("width")!, h: n("height")! } : { x: n("x")!, y: n("y")!, w: n("w")!, h: n("h")! };
    const ox = sparrow ? 0 - (n("frameX") ?? 0) || 0 : n("oX") ?? 0, oy = sparrow ? 0 - (n("frameY") ?? 0) || 0 : n("oY") ?? 0;
    const sw = (sparrow ? n("frameWidth") : n("oW")) ?? rect.w, sh = (sparrow ? n("frameHeight") : n("oH")) ?? rect.h;
    width = Math.max(width ?? 0, sw);
    height = Math.max(height ?? 0, sh);
    frames.push({ rect, offsetX: ox, offsetY: oy });
  }
  if (!frames.length) throw new Error("The XML atlas has no <SubTexture> or <sprite> frames");
  return { frames, tags: [], width, height };
}

/**
 * A Godot 4 SpriteFrames resource (.tres): each AtlasTexture's region (and
 * margin, for trimmed frames) is a frame; each animation is a tag over its
 * frames in order, with durations from the speed and per-frame multipliers.
 */
export function parseGodotSpriteFrames(tres: string): Atlas {
  const regions = new Map<string, { rect: Rect; ox: number; oy: number; w: number; h: number }>();
  for (const block of tres.split(/\n(?=\[)/)) {
    const id = /^\[sub_resource type="AtlasTexture" id="([^"]+)"\]/.exec(block)?.[1];
    if (!id) continue;
    const num = (k: string) => /Rect2\(([^)]*)\)/.exec(new RegExp(`^${k} = Rect2\\([^)]*\\)`, "m").exec(block)?.[0] ?? "")?.[1].split(",").map(Number);
    const r = num("region");
    if (!r) continue;
    const mg = num("margin") ?? [0, 0, 0, 0];
    regions.set(id, { rect: { x: r[0], y: r[1], w: r[2], h: r[3] }, ox: mg[0], oy: mg[1], w: r[2] + mg[2], h: r[3] + mg[3] });
  }
  const frames: Frame[] = [], tags: Tag[] = [];
  const anims = /animations\s*=\s*\[([\s\S]*)\]\s*$/m.exec(tres)?.[1] ?? "";
  for (const a of anims.split(/\}\s*,\s*\{(?=\s*"frames")/)) {
    const name = /"name":\s*&?"([^"]+)"/.exec(a)?.[1] ?? "default";
    const speed = Number(/"speed":\s*([\d.]+)/.exec(a)?.[1] ?? 5);
    const from = frames.length + 1;
    for (const f of a.matchAll(/"duration":\s*([\d.]+)\s*,\s*"texture":\s*SubResource\("([^"]+)"\)/g)) {
      const reg = regions.get(f[2]);
      if (!reg) throw new Error(`The .tres frame uses ${f[2]}, which isn't an AtlasTexture with a region`);
      frames.push({ rect: reg.rect, offsetX: reg.ox, offsetY: reg.oy, duration: Math.round((1000 / speed) * Number(f[1])) });
    }
    if (frames.length >= from) tags.push({ name, from, to: frames.length });
  }
  if (!frames.length) throw new Error("The .tres has no SpriteFrames animations with AtlasTexture frames");
  const all = [...regions.values()];
  return { frames, tags, width: Math.max(...all.map((r) => r.w)), height: Math.max(...all.map((r) => r.h)) };
}

/** An atlas file by its extension: .json (Aseprite, TexturePacker), .xml (TexturePacker), .tres (Godot). */
export function parseAtlasText(text: string, path: string): Atlas {
  if (/\.xml$/i.test(path)) return parseAtlasXml(text);
  if (/\.tres$/i.test(path)) return parseGodotSpriteFrames(text);
  return parseAtlas(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Frame images
// ---------------------------------------------------------------------------

export type Align = "bottom-center" | "center" | "top-left";

/** Copies each frame's rect into a canvas of the common size, aligned. */
export function frameImages(img: Rgba, frames: Frame[], align: Align = "bottom-center", size?: { w: number; h: number }): { width: number; height: number; images: Uint8Array[] } {
  const W = size?.w ?? Math.max(...frames.map((f) => f.rect.w + (f.offsetX ?? 0)));
  const H = size?.h ?? Math.max(...frames.map((f) => f.rect.h + (f.offsetY ?? 0)));
  const images = frames.map((f) => {
    const out = new Uint8Array(W * H * 4);
    let ox = f.offsetX ?? 0, oy = f.offsetY ?? 0;
    if (f.offsetX === undefined && f.offsetY === undefined) {
      if (align === "bottom-center") {
        ox = Math.floor((W - f.rect.w) / 2);
        oy = H - f.rect.h;
      } else if (align === "center") {
        ox = Math.floor((W - f.rect.w) / 2);
        oy = Math.floor((H - f.rect.h) / 2);
      }
    }
    for (let y = 0; y < f.rect.h; y++) {
      for (let x = 0; x < f.rect.w; x++) {
        const sx = f.rect.x + x, sy = f.rect.y + y, dx = ox + x, dy = oy + y;
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height || dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (dy * W + dx) * 4);
      }
    }
    return out;
  });
  return { width: W, height: H, images };
}

/** Tags from rows: one tag per row of frames, named by `names` (or row1, row2...). */
export function tagsFromRows(frames: Frame[], names?: string[]): Tag[] {
  const tags: Tag[] = [];
  frames.forEach((f, i) => {
    const row = f.row ?? 0;
    const last = tags.at(-1);
    if (last && (last as Tag & { row?: number }).row === row) last.to = i + 1;
    else tags.push({ name: names?.[tags.length] ?? `row${row + 1}`, from: i + 1, to: i + 1, row } as Tag & { row: number });
  });
  return tags.map(({ name, from, to }) => ({ name, from, to }));
}
