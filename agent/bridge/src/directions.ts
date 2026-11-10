// Directions (#43): which directions a sprite has and which can be
// mirrored, plus the 2:1 isometric projection of a top-down tile.
import type { Rgba } from "./pixel_grid.js";

export const DIRECTIONS_8 = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"] as const;
export const DIRECTIONS_4 = ["S", "W", "N", "E"] as const;
/** Horizontal mirror pairs: E <-> W, NE <-> NW, SE <-> SW. */
export const MIRROR: Record<string, string> = { E: "W", W: "E", NE: "NW", NW: "NE", SE: "SW", SW: "SE" };

/** The direction a tag stands for: "walk_SE", "SE", "idle-ne", "south" … */
export function tagDirection(name: string): string | undefined {
  const words: Record<string, string> = {
    south: "S", north: "N", east: "E", west: "W", southeast: "SE", southwest: "SW", northeast: "NE", northwest: "NW",
    down: "S", up: "N", right: "E", left: "W",
  };
  const parts = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const p of parts.reverse()) {
    if (words[p]) return words[p];
    if (/^(s|n|e|w|se|sw|ne|nw)$/.test(p)) return p.toUpperCase();
  }
  return undefined;
}

/**
 * What a set of tags covers: the directions present, which missing ones
 * can be made by mirroring, and which must be drawn.
 */
export function directionPlan(tags: string[], count: 4 | 8 = 8): { have: Record<string, string>; mirror: { from: string; to: string; tag: string }[]; draw: string[] } {
  const want = count === 8 ? DIRECTIONS_8 : DIRECTIONS_4;
  const have: Record<string, string> = {};
  for (const t of tags) {
    const d = tagDirection(t);
    if (d && !have[d]) have[d] = t;
  }
  const mirror: { from: string; to: string; tag: string }[] = [];
  const draw: string[] = [];
  for (const d of want) {
    if (have[d]) continue;
    const m = MIRROR[d];
    if (m && have[m]) mirror.push({ from: m, to: d, tag: have[m] });
    else draw.push(d);
  }
  return { have, mirror, draw };
}

/** The tag name for a direction, following the pattern of an existing one ("walk_E" -> "walk_W"). */
export function mirroredTagName(tag: string, from: string, to: string): string {
  const re = new RegExp(`(^|[^A-Za-z])(${from})(?=[^A-Za-z]|$)`, "i");
  if (re.test(tag)) return tag.replace(re, (_m, pre, d) => pre + (d === d.toUpperCase() ? to : to.toLowerCase()));
  return `${tag}_${to}`;
}

/**
 * Projects a top-down square tile (N x N) to a 2:1 isometric diamond
 * (2N x N): each output pixel takes the source pixel under it (nearest),
 * so colors stay exact.
 */
export function isoProject(img: Rgba): Rgba {
  const n = Math.min(img.width, img.height);
  const W = 2 * n, H = n;
  const out = new Uint8Array(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      // Inverse of X = x - y + n, Y = (x + y) / 2 (pixel centers).
      const cx = X + 0.5 - n, cy = 2 * (Y + 0.5);
      const x = Math.floor((cy + cx) / 2), y = Math.floor((cy - cx) / 2);
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      out.set(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4), (Y * W + X) * 4);
    }
  }
  return { width: W, height: H, data: out };
}

/** A 2:1 isometric grid of tiles `tile` px wide, as lines on a transparent canvas. */
export function isoGrid(width: number, height: number, tile = 32, color: [number, number, number, number] = [255, 255, 255, 90]): Rgba {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Lines x - 2y = k*tile and x + 2y = k*tile.
      const a = (((x - 2 * y) % tile) + tile) % tile, b = (x + 2 * y) % tile;
      if (a === 0 || b === 0) out.set(color, (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}
