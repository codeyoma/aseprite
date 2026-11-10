// Export for game engines (#49): pack frames into a sheet (trim, padding,
// extrusion, scale, power-of-two) and describe it for Godot, Unity,
// Phaser/PixiJS, Tiled or as plain JSON.
import { createHash } from "node:crypto";
import { bounds, scale, type Rgba } from "./image.js";

export interface PackOptions {
  columns?: number;
  /** Transparent pixels between frames. Default 0 (1 with extrude). */
  padding?: number;
  /** Repeat each frame's edge pixels outward by this many px (stops bleeding when filtering). */
  extrude?: number;
  trim?: boolean;
  scale?: number;
  powerOfTwo?: boolean;
}

export interface Placed {
  /** Where the (trimmed) frame sits in the sheet. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the trimmed rect sits in the original frame. */
  ox: number;
  oy: number;
  /** The original frame size. */
  sw: number;
  sh: number;
}

/**
 * The rect a frame keeps when trimmed. Sheets keep every pixel with any
 * alpha (a threshold of 1, not image.ts's OPAQUE), so faint pixels aren't
 * cut off; an empty frame keeps its top-left pixel.
 */
const trimRect = (img: Rgba) => bounds(img, 1) ?? { x: 0, y: 0, w: 1, h: 1 };

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Packs frames in a grid of equal cells (simple, predictable for engines),
 * each frame trimmed if asked and placed at its cell's top-left. `also`
 * (frames of the same size, e.g. a glow sheet's) count in the trim, so a
 * sheet placed later with placeLike keeps all of its pixels too.
 */
export function pack(frames: Rgba[], o: PackOptions = {}, also?: Rgba[]): { sheet: Rgba; placed: Placed[] } {
  const s = o.scale ?? 1;
  const scaled = frames.map((f) => scale(f, s));
  const ext = o.extrude ?? 0;
  const pad = o.padding ?? (ext ? 1 : 0);
  const trimmed = (f: Rgba, i: number) => {
    const a = bounds(f, 1), g = also?.[i] && bounds(scale(also[i], s), 1);
    if (!a || !g) return a ?? g ?? trimRect(f);
    const x = Math.min(a.x, g.x), y = Math.min(a.y, g.y);
    return { x, y, w: Math.max(a.x + a.w, g.x + g.w) - x, h: Math.max(a.y + a.h, g.y + g.h) - y };
  };
  const rects = scaled.map((f, i) => (o.trim ? trimmed(f, i) : { x: 0, y: 0, w: f.width, h: f.height }));
  const cellW = Math.max(...rects.map((r) => r.w)) + 2 * ext, cellH = Math.max(...rects.map((r) => r.h)) + 2 * ext;
  const cols = Math.max(1, Math.min(o.columns ?? Math.ceil(Math.sqrt(frames.length)), frames.length));
  const rows = Math.ceil(frames.length / cols);
  let W = cols * cellW + (cols - 1) * pad, H = rows * cellH + (rows - 1) * pad;
  if (o.powerOfTwo) {
    W = nextPow2(W);
    H = nextPow2(H);
  }
  const out = new Uint8Array(W * H * 4);
  const placed: Placed[] = [];
  scaled.forEach((f, i) => {
    const r = rects[i];
    const cx = (i % cols) * (cellW + pad), cy = Math.floor(i / cols) * (cellH + pad);
    const x = cx + ext, y = cy + ext;
    for (let yy = -ext; yy < r.h + ext; yy++) {
      for (let xx = -ext; xx < r.w + ext; xx++) {
        // Extruded pixels repeat the nearest edge pixel.
        const sx = r.x + Math.max(0, Math.min(r.w - 1, xx)), sy = r.y + Math.max(0, Math.min(r.h - 1, yy));
        const si = (sy * f.width + sx) * 4;
        out.set(f.data.subarray(si, si + 4), ((y + yy) * W + x + xx) * 4);
      }
    }
    placed.push({ x, y, w: r.w, h: r.h, ox: r.x, oy: r.y, sw: f.width, sh: f.height });
  });
  return { sheet: { width: W, height: H, data: out }, placed };
}

/** Places other frames (e.g. normal maps) exactly where pack() put the color frames. */
export function placeLike(frames: Rgba[], placed: Placed[], width: number, height: number, o: PackOptions = {}): Rgba {
  const s = o.scale ?? 1, ext = o.extrude ?? 0;
  const out = new Uint8Array(width * height * 4);
  frames.map((f) => scale(f, s)).forEach((f, i) => {
    const p = placed[i];
    for (let yy = -ext; yy < p.h + ext; yy++) for (let xx = -ext; xx < p.w + ext; xx++) {
      const sx = p.ox + Math.max(0, Math.min(p.w - 1, xx)), sy = p.oy + Math.max(0, Math.min(p.h - 1, yy));
      const si = (sy * f.width + sx) * 4;
      out.set(f.data.subarray(si, si + 4), ((p.y + yy) * width + p.x + xx) * 4);
    }
  });
  return { width, height, data: out };
}

export interface Anim {
  name: string;
  from: number; // 0-based frame index
  to: number;
  direction: "forward" | "reverse" | "pingpong";
  loop: boolean;
}

export interface SheetInfo {
  name: string;
  image: string; // file name of the sheet
  placed: Placed[];
  durations: number[]; // ms per frame
  anims: Anim[];
  width: number;
  height: number;
  /** Pivot as a fraction of the frame (0.5, 1 = bottom center). */
  pivot: [number, number];
  /** Slices in frame coordinates; center (relative to the slice) makes it a 9-patch. */
  slices?: Slice[];
  /**
   * Write the pivot on every JSON frame (TexturePacker's `pivot`, which Phaser's atlas loader reads as the
   * frame's origin): set when the pivot was asked for or comes from an effect, so the default changes nothing.
   */
  framePivot?: boolean;
  /** Effect timing for the game (meta.fx). */
  fx?: FxMeta;
  /** File name of the glow sheet (meta.glow), laid out like `image`. */
  glow?: string;
}

/**
 * meta.fx of the exported JSON (#71): the effect's frame rate, loop, windup (ms from its start to its impact),
 * origin (px in the original, scaled frame) and id, and the hit-stops recorded on the sprite (0-based frames,
 * like the frame keys). With several effects, the top-level fields are the first one's and `effects` lists all.
 * A sprite with hits and no recorded effect gets { hits } only.
 */
export interface FxMeta {
  id?: string;
  fps?: number;
  loop?: boolean;
  windup?: number;
  origin?: { x: number; y: number };
  hits: { frame: number; freeze_ms: number; shake_ms?: number; amp?: number }[];
  effects?: { id: string; layer: string; fps: number; loop: boolean; windup: number; origin: { x: number; y: number } }[];
}

/** The light (additive) layers and an image layer's pixels, for composing the color and glow sheets. */
export interface LayerPixels {
  image: Rgba;
  /** 0-255. */
  opacity: number;
}

const mul8 = (a: number, b: number) => { const t = a * b + 0x80; return ((t >> 8) + t) >> 8; };

/**
 * Layers composed bottom to top with Aseprite's normal blend (doc/blend_funcs.cpp rgba_blender_normal) at each
 * layer's opacity: the color sheet without the light layers (#71).
 */
export function composeNormal(layers: LayerPixels[], width: number, height: number): Rgba {
  const out = new Uint8Array(width * height * 4);
  for (const { image, opacity } of layers) {
    const d = image.data;
    for (let i = 0; i < out.length; i += 4) {
      const Sa0 = d[i + 3];
      if (!Sa0) continue;
      if (!out[i + 3]) { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = mul8(Sa0, opacity); continue; }
      const Sa = mul8(Sa0, opacity), Ba = out[i + 3], Ra = Sa + Ba - mul8(Ba, Sa);
      for (let k = 0; k < 3; k++) out[i + k] = out[i + k] + Math.trunc(((d[i + k] - out[i + k]) * Sa) / Ra);
      out[i + 3] = Ra;
    }
  }
  return { width, height, data: out };
}

/**
 * Light layers summed for additive drawing (the glow sheet, #71): the light each adds (color x alpha x
 * opacity) is summed, then stored with the largest alpha, so an engine's additive blend (src x alpha + dst)
 * adds the same light. One layer at full opacity comes out unchanged.
 */
export function composeLight(layers: LayerPixels[], width: number, height: number): Rgba {
  const n = width * height, sum = new Float64Array(n * 3), alpha = new Float64Array(n);
  for (const { image, opacity } of layers) {
    const d = image.data;
    for (let p = 0; p < n; p++) {
      const a = (d[p * 4 + 3] * opacity) / 255;
      if (!a) continue;
      for (let k = 0; k < 3; k++) sum[p * 3 + k] += (d[p * 4 + k] * a) / 255;
      alpha[p] = Math.max(alpha[p], a);
    }
  }
  const out = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const a = Math.round(alpha[p]);
    if (!a) continue;
    for (let k = 0; k < 3; k++) out[p * 4 + k] = Math.min(255, Math.round((sum[p * 3 + k] * 255) / alpha[p]));
    out[p * 4 + 3] = a;
  }
  return { width, height, data: out };
}

export interface Slice {
  name: string;
  bounds: { x: number; y: number; w: number; h: number };
  center?: { x: number; y: number; w: number; h: number };
}

/** A slice's 9-patch margins (px kept unstretched on each side), or undefined without a center. */
export function nineMargins(sl: Slice): { left: number; top: number; right: number; bottom: number } | undefined {
  const c = sl.center;
  if (!c) return undefined;
  return { left: c.x, top: c.y, right: sl.bounds.w - c.x - c.w, bottom: sl.bounds.h - c.y - c.h };
}

/** Frames of an animation in play order (reverse and ping-pong expanded). */
export function animFrames(a: Anim): number[] {
  const f: number[] = [];
  for (let i = a.from; i <= a.to; i++) f.push(i);
  if (a.direction === "reverse") return f.reverse();
  if (a.direction === "pingpong") return [...f, ...f.slice(1, -1).reverse()];
  return f;
}

/** Plain JSON in Aseprite's hash format (frames, durations, frameTags), which most tools read. */
export function jsonHash(s: SheetInfo): string {
  const frames: Record<string, unknown> = {};
  s.placed.forEach((p, i) => {
    frames[`${s.name} ${i}`] = {
      frame: { x: p.x, y: p.y, w: p.w, h: p.h },
      rotated: false,
      trimmed: p.w !== p.sw || p.h !== p.sh,
      spriteSourceSize: { x: p.ox, y: p.oy, w: p.w, h: p.h },
      sourceSize: { w: p.sw, h: p.sh },
      duration: s.durations[i],
      ...(s.framePivot ? { pivot: { x: s.pivot[0], y: s.pivot[1] } } : {}),
    };
  });
  return JSON.stringify({
    frames,
    meta: {
      app: "aseprite-agent", image: s.image, ...(s.glow ? { glow: s.glow } : {}),
      format: "RGBA8888", size: { w: s.width, h: s.height }, scale: "1",
      ...(s.fx ? { fx: s.fx } : {}),
      frameTags: s.anims.map((a) => ({ name: a.name, from: a.from, to: a.to, direction: a.direction === "pingpong" ? "pingpong" : a.direction })),
      // Aseprite's slice format: one key from frame 0.
      slices: (s.slices ?? []).map((sl) => ({
        name: sl.name, color: "#0000ffff",
        keys: [{ frame: 0, bounds: sl.bounds, ...(sl.center ? { center: sl.center } : {}) }],
      })),
    },
  }, null, 2);
}

/** Phaser 3 animations (load the atlas with this.load.atlas(key, png, jsonHash)). */
export function phaserAnims(s: SheetInfo, key: string): string {
  return JSON.stringify({
    anims: s.anims.map((a) => {
      const f = animFrames(a);
      const ms = f.reduce((t, i) => t + s.durations[i], 0) / f.length;
      return { key: a.name, frames: f.map((i) => ({ key, frame: `${s.name} ${i}` })), frameRate: Math.round(1000 / ms), repeat: a.loop ? -1 : 0 };
    }),
  }, null, 2);
}

/**
 * A Godot 4 SpriteFrames resource: one AtlasTexture per frame region, one
 * animation per tag (speed from the average duration, per-frame duration
 * multipliers for holds).
 */
export function godotSpriteFrames(s: SheetInfo, texturePath: string): string {
  const subs = s.placed.map((p, i) => [
    `[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]`,
    `atlas = ExtResource("1")`,
    `region = Rect2(${p.x}, ${p.y}, ${p.w}, ${p.h})`,
    p.w !== p.sw || p.h !== p.sh ? `margin = Rect2(${p.ox}, ${p.oy}, ${p.sw - p.w}, ${p.sh - p.h})` : "",
    "",
  ].filter((l, k, all) => l !== "" || k === all.length - 1).join("\n"));
  const anims = (s.anims.length ? s.anims : [{ name: "default", from: 0, to: s.placed.length - 1, direction: "forward", loop: true } as Anim]).map((a) => {
    const f = animFrames(a);
    const base = f.reduce((t, i) => t + s.durations[i], 0) / f.length;
    const frames = f.map((i) => `{\n"duration": ${(s.durations[i] / base).toFixed(3)},\n"texture": SubResource("AtlasTexture_${i}")\n}`).join(", ");
    return `{\n"frames": [${frames}],\n"loop": ${a.loop},\n"name": &"${a.name}",\n"speed": ${(1000 / base).toFixed(3)}\n}`;
  });
  return [
    `[gd_resource type="SpriteFrames" load_steps=${s.placed.length + 2} format=3]`,
    "",
    `[ext_resource type="Texture2D" path="${texturePath}" id="1"]`,
    "",
    ...subs,
    "[resource]",
    `animations = [${anims.join(", ")}]`,
    "",
  ].join("\n");
}

/** A deterministic 32-hex GUID from text (Unity meta files need one). */
export function guid(seed: string): string {
  return createHash("md5").update(seed).digest("hex");
}

/**
 * A Unity .png.meta: Sprite (multiple), point filtering, no compression,
 * one slice per frame with the pivot. Unity's rects count y from the bottom.
 */
export function unityMeta(s: SheetInfo, ppu = 16): string {
  const nine = (s.slices ?? []).find((sl) => sl.center);
  const sprites = s.placed.map((p, i) => {
    // The pivot is in the original frame; adjust for trimming.
    const px = (s.pivot[0] * p.sw - p.ox) / p.w, py = 1 - (s.pivot[1] * p.sh - p.oy) / p.h;
    // A 9-patch slice gives the border: left, bottom, right, top of the sprite's rect kept unstretched.
    let border = "{x: 0, y: 0, z: 0, w: 0}";
    if (nine?.center) {
      const cx0 = nine.bounds.x + nine.center.x - p.ox, cy0 = nine.bounds.y + nine.center.y - p.oy;
      const cx1 = cx0 + nine.center.w, cy1 = cy0 + nine.center.h;
      const k = (v: number) => Math.max(0, Math.round(v));
      border = `{x: ${k(cx0)}, y: ${k(p.h - cy1)}, z: ${k(p.w - cx1)}, w: ${k(cy0)}}`;
    }
    return `    - serializedVersion: 2
      name: ${s.name}_${i}
      rect:
        serializedVersion: 2
        x: ${p.x}
        y: ${s.height - p.y - p.h}
        width: ${p.w}
        height: ${p.h}
      alignment: 9
      pivot: {x: ${px.toFixed(4)}, y: ${py.toFixed(4)}}
      border: ${border}
      outline: []
      physicsShape: []
      tessellationDetail: 0
      bones: []
      spriteID: ${guid(`${s.name}/${i}`)}
      internalID: ${21300000 + i * 2}
      vertices: []
      indices:
      edges: []
      weights: []`;
  });
  return `fileFormatVersion: 2
guid: ${guid(s.image)}
TextureImporter:
  internalIDToNameTable: []
  serializedVersion: 12
  mipmaps:
    enableMipMap: 0
  textureFormat: 1
  maxTextureSize: 2048
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 2
  spriteExtrude: 1
  spriteMeshType: 0
  alignment: 9
  spritePivot: {x: ${s.pivot[0]}, y: ${1 - s.pivot[1]}}
  spritePixelsToUnits: ${ppu}
  alphaUsage: 1
  alphaIsTransparency: 1
  textureType: 8
  textureShape: 1
  platformSettings:
  - serializedVersion: 3
    buildTarget: DefaultTexturePlatform
    maxTextureSize: 2048
    resizeAlgorithm: 0
    textureFormat: -1
    textureCompression: 0
    compressionQuality: 50
  spriteSheet:
    serializedVersion: 2
    sprites:
${sprites.join("\n")}
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

/**
 * A Tiled tileset (.tsx) of a pack() sheet: frames are tiles on pack's grid.
 * Each tile is the largest (trimmed) frame size; extrusion becomes the
 * margin at the image edge plus extra spacing between tiles.
 */
export function tiledTileset(name: string, placed: Placed[], width: number, height: number, o: PackOptions = {}): string {
  const ext = o.extrude ?? 0;
  const pad = o.padding ?? (ext ? 1 : 0);
  const tw = Math.max(...placed.map((p) => p.w)), th = Math.max(...placed.map((p) => p.h));
  const columns = placed.filter((p) => p.y === placed[0].y).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tileset version="1.10" name="${name}" tilewidth="${tw}" tileheight="${th}" spacing="${pad + 2 * ext}" margin="${ext}" tilecount="${placed.length}" columns="${columns}">\n <image source="${name}.png" width="${width}" height="${height}"/>\n</tileset>\n`;
}

/**
 * A Godot 4 scene with a NinePatchRect per 9-patch slice: the slice's region
 * of the sheet (in frame 0) and its patch margins.
 */
export function godotNinePatch(s: SheetInfo, texturePath: string): string | undefined {
  const nine = (s.slices ?? []).filter((sl) => sl.center);
  if (!nine.length) return undefined;
  const p = s.placed[0];
  const nodes = nine.map((sl, i) => {
    const m = nineMargins(sl)!;
    return [
      i === 0 ? `[node name="${sl.name}" type="NinePatchRect"]` : `[node name="${sl.name}" type="NinePatchRect" parent="."]`,
      `texture = ExtResource("1")`,
      `region_rect = Rect2(${p.x + sl.bounds.x - p.ox}, ${p.y + sl.bounds.y - p.oy}, ${sl.bounds.w}, ${sl.bounds.h})`,
      `patch_margin_left = ${m.left}`,
      `patch_margin_top = ${m.top}`,
      `patch_margin_right = ${m.right}`,
      `patch_margin_bottom = ${m.bottom}`,
      `offset_right = ${sl.bounds.w}`,
      `offset_bottom = ${sl.bounds.h}`,
      "",
    ].join("\n");
  });
  return [`[gd_scene load_steps=2 format=3]`, "", `[ext_resource type="Texture2D" path="${texturePath}" id="1"]`, "", ...nodes].join("\n");
}
