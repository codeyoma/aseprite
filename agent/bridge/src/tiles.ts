// Tilesets and autotiles (#46). A terrain set is built from a template of
// five tiles; every output tile is four quarters, each picked by its
// neighbors (the way RPG Maker autotiles work):
//
//   template: [island, vertical, horizontal, fill, inner]
//     island      a lone tile: outer corners and edges on every side
//     vertical    a tile in a vertical strip: edges on the left and right
//     horizontal  a tile in a horizontal strip: edges on the top and bottom
//     fill        the middle of the terrain
//     inner       fill with all four inner corners
//
// For the NW quarter of a tile with neighbors N, W and NW:
//   no N, no W        -> island (outer corner)
//   N, no W           -> vertical (west edge)
//   W, no N           -> horizontal (north edge)
//   N, W, no NW       -> inner (inner corner)
//   N, W, NW          -> fill
import type { Rgba } from "./pixel_grid.js";

// Neighbor bits (Godot/Tiled order around the tile).
export const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

/** Drops corner bits whose two sides aren't both set (they don't change the tile). */
export function reduceMask(m: number): number {
  let r = m & (N | E | S | W);
  if (m & NE && m & N && m & E) r |= NE;
  if (m & SE && m & S && m & E) r |= SE;
  if (m & SW && m & S && m & W) r |= SW;
  if (m & NW && m & N && m & W) r |= NW;
  return r;
}

/** The distinct masks of a 47-tile blob set (or the 16 side-only masks). */
export function blobMasks(kind: 47 | 16 = 47): number[] {
  const set = new Set<number>();
  for (let m = 0; m < 256; m++) {
    if (kind === 16) {
      const sides = m & (N | E | S | W);
      // Side-only sets treat corners as filled whenever both sides are.
      set.add(reduceMask(sides | NE | SE | SW | NW));
    } else set.add(reduceMask(m));
  }
  return [...set].sort((a, b) => a - b);
}

type Piece = "island" | "vertical" | "horizontal" | "fill" | "inner";
const PIECE_INDEX: Record<Piece, number> = { island: 0, vertical: 1, horizontal: 2, fill: 3, inner: 4 };

function quarterPiece(vert: boolean, horiz: boolean, diag: boolean): Piece {
  if (!vert && !horiz) return "island";
  if (vert && !horiz) return "vertical";
  if (!vert && horiz) return "horizontal";
  return diag ? "fill" : "inner";
}

/**
 * The tile for a mask, composed from the template (five tiles of size t
 * side by side). Tiles must be an even size so quarters split evenly.
 */
export function composeTile(template: Rgba, t: number, mask: number): Uint8Array {
  const out = new Uint8Array(t * t * 4);
  const h = t / 2;
  const quarters: [number, number, number, number, number][] = [
    // qx, qy, vertical neighbor, horizontal neighbor, diagonal
    [0, 0, N, W, NW],
    [1, 0, N, E, NE],
    [0, 1, S, W, SW],
    [1, 1, S, E, SE],
  ];
  for (const [qx, qy, v, hz, d] of quarters) {
    const piece = quarterPiece(!!(mask & v), !!(mask & hz), !!(mask & d));
    const sx0 = PIECE_INDEX[piece] * t + qx * h, sy0 = qy * h;
    for (let y = 0; y < h; y++) {
      const src = ((sy0 + y) * template.width + sx0) * 4;
      out.set(template.data.subarray(src, src + h * 4), ((qy * h + y) * t + qx * h) * 4);
    }
  }
  return out;
}

export interface Tileset {
  image: Rgba;
  tile: number;
  columns: number;
  /** masks[i] = the neighbor mask of tile i (row-major). */
  masks: number[];
}

/**
 * A 6-tile template (2 tiles wide, 3 high, the RPG Maker layout) as the
 * 5-tile row. In quarter-tile units (4 x 6):
 *   top row:    a lone-tile preview (unused) | inner corners
 *   rows 2-3:   a 2x2 block of terrain with its border: outer corners,
 *               edges and fill.
 * Each output piece takes, for each of its quarters, the quarter at the
 * matching place in that block.
 */
export function templateFrom2x3(tpl: Rgba, t: number): Rgba {
  if (t % 2) throw new Error("Tile size must be even (tiles are made of quarters)");
  if (tpl.width < 2 * t || tpl.height < 3 * t) throw new Error(`A 6-tile template is 2 tiles wide and 3 high (${2 * t}x${3 * t} px)`);
  const h = t / 2, W = 5 * t, out = new Uint8Array(W * t * 4);
  // [qx, qy] of the source quarter for each piece's NW, NE, SW, SE quarter.
  const pieces: [number, number][][] = [
    [[0, 2], [3, 2], [0, 5], [3, 5]], // island: outer corners
    [[0, 4], [3, 4], [0, 3], [3, 3]], // vertical: west and east edges
    [[2, 2], [1, 2], [2, 5], [1, 5]], // horizontal: north and south edges
    [[2, 4], [1, 4], [2, 3], [1, 3]], // fill
    [[2, 0], [3, 0], [2, 1], [3, 1]], // inner corners
  ];
  pieces.forEach((quarters, p) => {
    quarters.forEach(([qx, qy], q) => {
      const dx = p * t + (q % 2) * h, dy = Math.floor(q / 2) * h;
      for (let y = 0; y < h; y++) {
        const src = ((qy * h + y) * tpl.width + qx * h) * 4;
        out.set(tpl.data.subarray(src, src + h * 4), ((dy + y) * W + dx) * 4);
      }
    });
  });
  return { width: W, height: t, data: out };
}

/** Builds the whole set laid out in `columns` columns. */
export function buildTileset(template: Rgba, t: number, kind: 47 | 16 = 47, columns = 8): Tileset {
  if (t % 2) throw new Error("Tile size must be even (tiles are made of quarters)");
  if (template.width < t * 5 || template.height < t) throw new Error(`The template needs 5 tiles of ${t}px in a row: island, vertical, horizontal, fill, inner`);
  const masks = blobMasks(kind);
  const cols = Math.min(columns, masks.length);
  const rows = Math.ceil(masks.length / cols);
  const W = cols * t, H = rows * t;
  const data = new Uint8Array(W * H * 4);
  masks.forEach((m, i) => {
    const tile = composeTile(template, t, m);
    const ox = (i % cols) * t, oy = Math.floor(i / cols) * t;
    for (let y = 0; y < t; y++) data.set(tile.subarray(y * t * 4, (y + 1) * t * 4), ((oy + y) * W + ox) * 4);
  });
  return { image: { width: W, height: H, data }, tile: t, columns: cols, masks };
}

/** The neighbor mask of cell (x, y) in a terrain map (true = terrain). */
export function cellMask(map: boolean[][], x: number, y: number): number {
  const at = (dx: number, dy: number) => !!map[y + dy]?.[x + dx];
  let m = 0;
  if (at(0, -1)) m |= N;
  if (at(1, -1)) m |= NE;
  if (at(1, 0)) m |= E;
  if (at(1, 1)) m |= SE;
  if (at(0, 1)) m |= S;
  if (at(-1, 1)) m |= SW;
  if (at(-1, 0)) m |= W;
  if (at(-1, -1)) m |= NW;
  return m;
}

/** The tile index (0-based, into the set) of every terrain cell of a map; -1 for empty cells. */
export function mapIndices(ts: Tileset, map: boolean[][], kind: 47 | 16 = 47): number[][] {
  const index = new Map(ts.masks.map((m, i) => [m, i]));
  return map.map((row, y) => row.map((on, x) => {
    if (!on) return -1;
    const m = cellMask(map, x, y);
    return index.get(kind === 16 ? reduceMask((m & (N | E | S | W)) | NE | SE | SW | NW) : reduceMask(m))!;
  }));
}

/** Paints a terrain map with the tileset (a preview, and the seam test). */
export function renderMap(ts: Tileset, map: boolean[][], kind: 47 | 16 = 47): Rgba {
  const t = ts.tile, rows = map.length, cols = map[0].length;
  const W = cols * t, H = rows * t, data = new Uint8Array(W * H * 4);
  const idx = mapIndices(ts, map, kind);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = idx[y][x];
      if (i < 0) continue;
      const sx = (i % ts.columns) * t, sy = Math.floor(i / ts.columns) * t;
      for (let r = 0; r < t; r++) {
        const src = ((sy + r) * ts.image.width + sx) * 4;
        data.set(ts.image.data.subarray(src, src + t * 4), ((y * t + r) * W + x * t) * 4);
      }
    }
  }
  return { width: W, height: H, data };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const BITS: [number, string][] = [
  [E, "right_side"], [SE, "bottom_right_corner"], [S, "bottom_side"], [SW, "bottom_left_corner"],
  [W, "left_side"], [NW, "top_left_corner"], [N, "top_side"], [NE, "top_right_corner"],
];

/** A Godot 4 TileSet resource with one terrain (match corners and sides). */
export function godotTileset(ts: Tileset, imagePath: string, name = "terrain"): string {
  const lines = [
    `[gd_resource type="TileSet" load_steps=3 format=3]`,
    "",
    `[ext_resource type="Texture2D" path="${imagePath}" id="1"]`,
    "",
    `[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]`,
    `texture = ExtResource("1")`,
    `texture_region_size = Vector2i(${ts.tile}, ${ts.tile})`,
  ];
  ts.masks.forEach((m, i) => {
    const c = `${i % ts.columns}:${Math.floor(i / ts.columns)}/0`;
    lines.push(`${c} = 0`, `${c}/terrain_set = 0`, `${c}/terrain = 0`);
    for (const [bit, name] of BITS) if (m & bit) lines.push(`${c}/terrains_peering_bit/${name} = 0`);
  });
  lines.push(
    "",
    "[resource]",
    `tile_size = Vector2i(${ts.tile}, ${ts.tile})`,
    "terrain_set_0/mode = 0",
    `terrain_set_0/terrain_0/name = "${name}"`,
    "terrain_set_0/terrain_0/color = Color(0.4, 0.7, 0.4, 1)",
    `sources/0 = SubResource("TileSetAtlasSource_1")`,
    "",
  );
  return lines.join("\n");
}

/** A Tiled tileset (.tsx) with a mixed wang set: wangid = top, top-right, right, bottom-right, bottom, bottom-left, left, top-left. */
export function tiledTileset(ts: Tileset, imagePath: string, name = "terrain"): string {
  const order = [N, NE, E, SE, S, SW, W, NW];
  const tiles = ts.masks
    .map((m, i) => `   <wangtile tileid="${i}" wangid="${order.map((b) => (m & b ? 1 : 0)).join(",")}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" name="${name}" tilewidth="${ts.tile}" tileheight="${ts.tile}" tilecount="${ts.masks.length}" columns="${ts.columns}">
 <image source="${imagePath}" width="${ts.image.width}" height="${ts.image.height}"/>
 <wangsets>
  <wangset name="${name}" type="mixed" tile="-1">
   <wangcolor name="${name}" color="#66b366" tile="-1" probability="1"/>
${tiles}
  </wangset>
 </wangsets>
</tileset>
`;
}

/** Plain JSON: tile size, columns and each tile's neighbor mask (bits N=1 … NW=128). */
export function jsonTileset(ts: Tileset): string {
  return JSON.stringify({ tile: ts.tile, columns: ts.columns, bits: { N, NE, E, SE, S, SW, W, NW }, masks: ts.masks }, null, 2);
}

/** How well a tile wraps: the share of edge pixels that differ from the opposite edge (0 = seamless). */
export function seamScore(tile: Rgba): { horizontal: number; vertical: number } {
  const { width: w, height: h, data } = tile;
  const diff = (i: number, j: number) => Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) + Math.abs(data[i + 3] - data[j + 3]) > 60;
  let hz = 0, vt = 0;
  for (let y = 0; y < h; y++) if (diff((y * w) * 4, (y * w + w - 1) * 4)) hz++;
  for (let x = 0; x < w; x++) if (diff(x * 4, ((h - 1) * w + x) * 4)) vt++;
  return { horizontal: hz / h, vertical: vt / w };
}

export interface SeamFix {
  image: Rgba;
  /** Pixels changed on the left/right and top/bottom seams. */
  fixed: { horizontal: number; vertical: number };
  /** Seams too wide to fix by touching edge pixels (share of the edge that clashes). */
  tooWide: { horizontal?: number; vertical?: number };
}

/**
 * Fixes small seams so a tile repeats cleanly: where an edge pixel clashes
 * with the pixel on the opposite edge, the one whose color is rarer in the
 * tile takes the other's color. Only when at most `maxShare` of an edge
 * clashes; a wider seam needs redrawing, and is reported instead.
 */
export function makeSeamless(tile: Rgba, maxShare = 0.25): SeamFix {
  const { width: w, height: h } = tile;
  const data = new Uint8Array(tile.data);
  const key = (i: number) => (data[i] << 24 | data[i + 1] << 16 | data[i + 2] << 8 | data[i + 3]) >>> 0;
  const count = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) count.set(key(i), (count.get(key(i)) ?? 0) + 1);
  const clash = (i: number, j: number) => Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) + Math.abs(data[i + 3] - data[j + 3]) > 60;
  const settle = (i: number, j: number) => {
    const [from, to] = (count.get(key(i)) ?? 0) >= (count.get(key(j)) ?? 0) ? [i, j] : [j, i];
    data.set(data.subarray(from, from + 4), to);
  };
  const before = seamScore(tile);
  const fixed = { horizontal: 0, vertical: 0 }, tooWide: SeamFix["tooWide"] = {};
  if (before.horizontal > maxShare) tooWide.horizontal = before.horizontal;
  else for (let y = 0; y < h; y++) {
    const i = y * w * 4, j = (y * w + w - 1) * 4;
    if (clash(i, j)) { settle(i, j); fixed.horizontal++; }
  }
  if (before.vertical > maxShare) tooWide.vertical = before.vertical;
  else for (let x = 0; x < w; x++) {
    const i = x * 4, j = ((h - 1) * w + x) * 4;
    if (clash(i, j)) { settle(i, j); fixed.vertical++; }
  }
  return { image: { width: w, height: h, data }, fixed, tooWide };
}
