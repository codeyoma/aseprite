// Export for game engines (#49): pack frames into a sheet (trim, padding,
// extrusion, scale, power-of-two) and describe it for Godot, Unity,
// Phaser/PixiJS, Tiled or as plain JSON.
import { createHash } from "node:crypto";
import type { Rgba } from "./pixel_grid.js";

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

function scaleImg(img: Rgba, s: number): Rgba {
  if (s === 1) return img;
  const w = img.width * s, h = img.height * s, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 4;
    out.set(img.data.subarray(i, i + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

function trimRect(img: Rgba): { x: number; y: number; w: number; h: number } {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3]) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Packs frames in a grid of equal cells (simple, predictable for engines),
 * each frame trimmed if asked and placed at its cell's top-left.
 */
export function pack(frames: Rgba[], o: PackOptions = {}): { sheet: Rgba; placed: Placed[] } {
  const s = o.scale ?? 1;
  const scaled = frames.map((f) => scaleImg(f, s));
  const ext = o.extrude ?? 0;
  const pad = o.padding ?? (ext ? 1 : 0);
  const rects = scaled.map((f) => (o.trim ? trimRect(f) : { x: 0, y: 0, w: f.width, h: f.height }));
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
  frames.map((f) => scaleImg(f, s)).forEach((f, i) => {
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
    };
  });
  return JSON.stringify({
    frames,
    meta: {
      app: "aseprite-agent", image: s.image, format: "RGBA8888", size: { w: s.width, h: s.height }, scale: "1",
      frameTags: s.anims.map((a) => ({ name: a.name, from: a.from, to: a.to, direction: a.direction === "pingpong" ? "pingpong" : a.direction })),
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
  const sprites = s.placed.map((p, i) => {
    // The pivot is in the original frame; adjust for trimming.
    const px = (s.pivot[0] * p.sw - p.ox) / p.w, py = 1 - (s.pivot[1] * p.sh - p.oy) / p.h;
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
      border: {x: 0, y: 0, z: 0, w: 0}
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
