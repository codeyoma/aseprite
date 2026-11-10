// Voxels and 2.5D (#45): read MagicaVoxel .vox models (or a layered
// sprite, one layer per height) and render them as pixel-exact isometric
// sprites with three shades per material.
import { adjust, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

export interface VoxelModel {
  sx: number;
  sy: number;
  sz: number;
  /** x, y, z, palette index (1-255). z is up. */
  voxels: [number, number, number, number][];
  /** 256 colors; index 0 unused. */
  palette: RGBA[];
}

/** MagicaVoxel's default palette (used when a file has no RGBA chunk). */
export function defaultPalette(): RGBA[] {
  // The default palette is a 6x6x6 color cube plus ramps; this follows its layout closely enough for previews.
  const out: RGBA[] = [{ r: 0, g: 0, b: 0, a: 0 }];
  const steps = [255, 204, 153, 102, 51, 0];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push({ r, g, b, a: 255 });
  const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const c of ["r", "g", "b", "w"]) {
    for (const v of ramp) out.push(c === "w" ? { r: v, g: v, b: v, a: 255 } : { r: c === "r" ? v : 0, g: c === "g" ? v : 0, b: c === "b" ? v : 0, a: 255 });
  }
  while (out.length < 256) out.push({ r: 0, g: 0, b: 0, a: 255 });
  return out.slice(0, 256);
}

/** Parses a .vox file (the first model; SIZE, XYZI and RGBA chunks). */
export function parseVox(buf: Buffer): VoxelModel {
  if (buf.toString("ascii", 0, 4) !== "VOX ") throw new Error("Not a MagicaVoxel .vox file");
  let size: [number, number, number] | undefined;
  let voxels: [number, number, number, number][] | undefined;
  let palette: RGBA[] | undefined;
  // Chunks: id(4) contentBytes(4) childrenBytes(4) content… children…
  const walk = (start: number, end: number) => {
    let p = start;
    while (p + 12 <= end) {
      const id = buf.toString("ascii", p, p + 4);
      const n = buf.readUInt32LE(p + 4), m = buf.readUInt32LE(p + 8);
      const c = p + 12;
      if (id === "SIZE" && !size) size = [buf.readUInt32LE(c), buf.readUInt32LE(c + 4), buf.readUInt32LE(c + 8)];
      if (id === "XYZI" && !voxels) {
        const count = buf.readUInt32LE(c);
        voxels = [];
        for (let i = 0; i < count; i++) {
          const q = c + 4 + i * 4;
          voxels.push([buf[q], buf[q + 1], buf[q + 2], buf[q + 3]]);
        }
      }
      if (id === "RGBA") {
        palette = [{ r: 0, g: 0, b: 0, a: 0 }];
        // Entry i holds the color of index i + 1.
        for (let i = 0; i < 255; i++) palette.push({ r: buf[c + i * 4], g: buf[c + i * 4 + 1], b: buf[c + i * 4 + 2], a: buf[c + i * 4 + 3] });
      }
      if (id === "MAIN") walk(c + n, c + n + m);
      p = c + n + m;
    }
  };
  walk(8, buf.length);
  if (!size || !voxels) throw new Error("The .vox file has no model (SIZE/XYZI)");
  return { sx: size[0], sy: size[1], sz: size[2], voxels, palette: palette ?? defaultPalette() };
}

/** Writes a minimal .vox (tests and exporting layered sprites). */
export function writeVox(m: VoxelModel): Buffer {
  const chunk = (id: string, content: Buffer) => {
    const h = Buffer.alloc(12);
    h.write(id, 0, "ascii");
    h.writeUInt32LE(content.length, 4);
    h.writeUInt32LE(0, 8);
    return Buffer.concat([h, content]);
  };
  const size = Buffer.alloc(12);
  size.writeUInt32LE(m.sx, 0);
  size.writeUInt32LE(m.sy, 4);
  size.writeUInt32LE(m.sz, 8);
  const xyzi = Buffer.alloc(4 + m.voxels.length * 4);
  xyzi.writeUInt32LE(m.voxels.length, 0);
  m.voxels.forEach(([x, y, z, i], k) => xyzi.set([x, y, z, i], 4 + k * 4));
  const rgba = Buffer.alloc(1024);
  for (let i = 0; i < 255; i++) {
    const c = m.palette[i + 1] ?? { r: 0, g: 0, b: 0, a: 255 };
    rgba.set([c.r, c.g, c.b, c.a], i * 4);
  }
  const children = Buffer.concat([chunk("SIZE", size), chunk("XYZI", xyzi), chunk("RGBA", rgba)]);
  const main = Buffer.alloc(12);
  main.write("MAIN", 0, "ascii");
  main.writeUInt32LE(0, 4);
  main.writeUInt32LE(children.length, 8);
  const head = Buffer.alloc(8);
  head.write("VOX ", 0, "ascii");
  head.writeUInt32LE(150, 4);
  return Buffer.concat([head, main, children]);
}

/** Rotates the model 90 degrees around the vertical axis `turns` times. */
export function rotateModel(m: VoxelModel, turns: number): VoxelModel {
  let out = m;
  for (let t = 0; t < ((turns % 4) + 4) % 4; t++) {
    out = {
      sx: out.sy, sy: out.sx, sz: out.sz, palette: out.palette,
      voxels: out.voxels.map(([x, y, z, i]) => [out.sy - 1 - y, x, z, i] as [number, number, number, number]),
    };
  }
  return out;
}

/** Top, left and right face shades of a material (lit top, mid left, dark right). */
export function faceShades(c: RGBA): [RGBA, RGBA, RGBA] {
  return [adjust(c, { lightness: 0.06 }), adjust(c, { lightness: -0.06 }), adjust(c, { lightness: -0.16, chroma: -0.1 })];
}

/**
 * Renders a model as a 2:1 isometric sprite: each voxel is a 4x4 block
 * (a 4x2 top and 2x2 left and right sides), drawn back to front. The
 * image is trimmed to the model.
 */
export function renderIso(m: VoxelModel): Rgba {
  const shades = new Map<number, [RGBA, RGBA, RGBA]>();
  const occupied = new Set(m.voxels.map(([x, y, z]) => `${x},${y},${z}`));
  // Screen position of a voxel's block: x right/down, y left/down, z up.
  const sx = (x: number, y: number) => (x - y) * 2 + (m.sy - 1) * 2;
  const sy = (x: number, y: number, z: number) => (x + y) - z * 2 + (m.sz - 1) * 2;
  const W = (m.sx + m.sy) * 2, H = m.sx + m.sy + m.sz * 2 + 2;
  const out = new Uint8Array(W * H * 4);
  const put = (x: number, y: number, c: RGBA) => {
    if (x >= 0 && y >= 0 && x < W && y < H) out.set([c.r, c.g, c.b, 255], (y * W + x) * 4);
  };
  const order = m.voxels.slice().sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[2] - b[2]);
  for (const [x, y, z, i] of order) {
    if (!shades.has(i)) shades.set(i, faceShades(m.palette[i] ?? { r: 255, g: 0, b: 255, a: 255 }));
    const [top, left, right] = shades.get(i)!;
    const X = sx(x, y), Y = sy(x, y, z);
    // Top (skipped under another voxel), left (+y side), right (+x side).
    if (!occupied.has(`${x},${y},${z + 1}`)) {
      put(X + 1, Y, top);
      put(X + 2, Y, top);
      for (let k = 0; k < 4; k++) put(X + k, Y + 1, top);
    }
    for (let k = 0; k < 2; k++) {
      put(X, Y + 2 + k, left);
      put(X + 1, Y + 2 + k, left);
      put(X + 2, Y + 2 + k, right);
      put(X + 3, Y + 2 + k, right);
    }
  }
  // Trim to the drawn pixels.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (out[(y * W + x) * 4 + 3]) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x1 < 0) return { width: 1, height: 1, data: new Uint8Array(4) };
  const w = x1 - x0 + 1, h = y1 - y0 + 1, t = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) t.set(out.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1 + 1) * 4), y * w * 4);
  return { width: w, height: h, data: t };
}

/** A model from layer images (bottom layer = z 0): every opaque pixel is a voxel; image y becomes depth. */
export function layersToModel(layers: Rgba[]): VoxelModel {
  const palette: RGBA[] = [{ r: 0, g: 0, b: 0, a: 0 }];
  const index = new Map<string, number>();
  const voxels: [number, number, number, number][] = [];
  const w = layers[0].width, h = layers[0].height;
  layers.forEach((img, z) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i + 3] < 128) continue;
      const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
      let k = index.get(key);
      if (k === undefined) {
        if (palette.length >= 256) continue;
        k = palette.length;
        index.set(key, k);
        palette.push({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 });
      }
      voxels.push([x, y, z, k]);
    }
  });
  while (palette.length < 256) palette.push({ r: 0, g: 0, b: 0, a: 255 });
  return { sx: w, sy: h, sz: layers.length, voxels, palette };
}
