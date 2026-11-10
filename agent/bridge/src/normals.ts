// Normal maps and 2D lighting (#47).
import { toOklch } from "./color.js";
import type { Rgba } from "./pixel_grid.js";
import { distanceField } from "./shading.js";

export interface NormalOptions {
  /** Where height comes from: a bevel from the silhouette, the colors' lightness, or a grayscale height image. */
  source?: "bevel" | "luminance" | "height";
  height?: Rgba;
  /** Bevel width in px (bevel source). Default: a third of the shape's thickness. */
  bevel?: number;
  /** Steepness: higher tilts normals more. Default 1. */
  strength?: number;
  /** Quantize to this many tilt levels (0 = smooth). Default 2, for a pixel look. */
  levels?: number;
  /** "opengl" (Godot, Unity: green up) or "directx" (green down). Default opengl. */
  convention?: "opengl" | "directx";
}

/** Height (0..1) per pixel; 0 outside the shape. */
export function heightField(img: Rgba, o: NormalOptions = {}): Float64Array {
  const { width: w, height: h, data } = img;
  const out = new Float64Array(w * h);
  if (o.source === "height" && o.height) {
    for (let i = 0; i < w * h; i++) out[i] = o.height.data[i * 4 + 3] >= 128 ? o.height.data[i * 4] / 255 : 0;
    return out;
  }
  if (o.source === "luminance") {
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] < 128) continue;
      out[i] = toOklch({ r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2], a: 255 }).L;
    }
    return out;
  }
  // Bevel: rises from the silhouette edge to a plateau `bevel` px inside, rounded.
  const d = distanceField(img, false);
  let max = 0;
  for (let i = 0; i < w * h; i++) max = Math.max(max, d[i]);
  const r = o.bevel ?? Math.max(1.5, max * 0.66);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 128) continue;
    const t = Math.min(1, d[i] / r);
    out[i] = Math.sqrt(1 - (1 - t) * (1 - t)); // quarter circle: steep at the edge, flat on top
  }
  return out;
}

/** Tangent-space normals from height, encoded as RGB (alpha kept from the sprite). */
export function normalMap(img: Rgba, o: NormalOptions = {}): Rgba {
  const { width: w, height: h, data } = img;
  const hf = heightField(img, o);
  const s = (o.strength ?? 1) * (o.source === "bevel" || !o.source ? (o.bevel ?? 3) : 6);
  const levels = o.levels ?? 2;
  const out = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : hf[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i * 4 + 3] < 128) continue;
      // Central differences; image y grows downward.
      const dx = (at(x + 1, y) - at(x - 1, y)) / 2, dy = (at(x, y + 1) - at(x, y - 1)) / 2;
      let nx = -dx * s, ny = dy * s, nz = 1; // ny: up-positive (a slope rising downward faces up)
      if (levels > 0) {
        // Pixel look: snap the direction to 8 sectors and the tilt to `levels` steps.
        const tilt = Math.atan(Math.hypot(nx, ny));
        if (tilt > 0.05) {
          const ang = Math.round(Math.atan2(ny, nx) / (Math.PI / 4)) * (Math.PI / 4);
          const t = (Math.ceil((tilt / (Math.PI / 2)) * levels - 1e-9) / levels) * (Math.PI / 2) * 0.8;
          nx = Math.cos(ang) * Math.sin(t);
          ny = Math.sin(ang) * Math.sin(t);
          nz = Math.cos(t);
        } else {
          nx = 0;
          ny = 0;
        }
      }
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      if (o.convention === "directx") ny = -ny;
      out.set([Math.round((nx * 0.5 + 0.5) * 255), Math.round((ny * 0.5 + 0.5) * 255), Math.round((nz * 0.5 + 0.5) * 255), 255], i * 4);
    }
  }
  return { width: w, height: h, data: out };
}

export interface Light {
  /** Directional light: the direction light comes FROM (x right, y up, z toward the viewer). */
  dir?: [number, number, number];
  /** Point light at (x, y) in pixels and height z (px above the sprite). */
  point?: [number, number, number];
  ambient?: number;
  color?: [number, number, number];
}

/** The sprite lit by a light through its normal map (Lambert), for previews. */
export function light(albedo: Rgba, normals: Rgba, l: Light, convention: "opengl" | "directx" = "opengl"): Rgba {
  const { width: w, height: h } = albedo;
  const out = new Uint8Array(w * h * 4);
  const amb = l.ambient ?? 0.25;
  const col = l.color ?? [1, 1, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (albedo.data[i + 3] < 128) continue;
      let nx = normals.data[i] / 127.5 - 1, ny = normals.data[i + 1] / 127.5 - 1;
      const nz = normals.data[i + 2] / 127.5 - 1;
      if (convention === "directx") ny = -ny;
      if (normals.data[i + 3] < 128) {
        nx = 0;
        ny = 0;
      }
      let lx: number, ly: number, lz: number;
      if (l.point) {
        lx = l.point[0] - x;
        ly = -(l.point[1] - y);
        lz = l.point[2];
      } else [lx, ly, lz] = l.dir ?? [-1, 1, 1];
      const len = Math.hypot(lx, ly, lz) || 1;
      const diff = Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
      const k = Math.min(1.6, amb + diff);
      out.set([0, 1, 2].map((c) => Math.min(255, Math.round(albedo.data[i + c] * k * col[c]))).concat([255]), i);
    }
  }
  return { width: w, height: h, data: out };
}
