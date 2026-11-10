// Tilesets as tools (#46): build a 47-tile blob or 16-tile autotile set
// from a 5-tile template, preview it on a sample map, export it for
// Godot 4, Tiled and as JSON; check how well a tile wraps.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import type { Rgba } from "./pixel_grid.js";
import { readPng } from "./sheet_tools.js";
import { buildTileset, godotTileset, jsonTileset, renderMap, seamScore, tiledTileset } from "./tiles.js";
import { failure, text, type AsepriteRequester, type Tool, type ToolResult } from "./tool.js";


async function pixels(aseprite: AsepriteRequester, input: { path?: string; layer?: string; frame?: number }): Promise<Rgba> {
  if (input.path) return readPng(input.path);
  const { result, binary } = await aseprite.request("snapshot", { layer: input.layer, frame: input.frame });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

function writePng(path: string, img: Rgba) {
  mkdirSync(dirname(path), { recursive: true });
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(path, PNG.sync.write(png));
}

/** A sample terrain map with every kind of edge, corner and hole. */
export const SAMPLE_MAP = [
  "............",
  "..XXXX......",
  ".XXXXXXX..X.",
  ".XX..XXX.XX.",
  ".XXXXX.X.X..",
  "...XXX......",
  "............",
].map((r) => [...r].map((c) => c === "X"));

const send = (img: Rgba) => Buffer.from(img.data).toString("base64");

export const TILE_TOOLS: Tool[] = [
  {
    name: "make_autotile",
    title: "Make autotile set",
    description:
      "Build a terrain autotile set from a 5-tile template drawn side by side at the top-left of a layer (or a PNG): " +
      "1 island (a lone tile: outer corners and edges all around), 2 vertical strip (edges left and right), 3 " +
      "horizontal strip (edges top and bottom), 4 fill (the middle), 5 inner corners (fill with the 4 inner corners). " +
      "Makes the 47-tile blob set (or the 16-tile side-only set) as a new sprite, a preview map, and optional exports: " +
      "a Godot 4 TileSet (.tres) with terrain peering bits, a Tiled .tsx wang set, and a JSON bitmask map. Tile size must be even.",
    input: z.object({
      layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      path: z.string().optional().describe("Template PNG instead of a layer."),
      tile: z.number().int().min(4).max(256).optional().describe("Tile size. Default: the template's height."),
      kind: z.union([z.literal(47), z.literal(16)]).optional().describe("Default 47."),
      columns: z.number().int().min(1).max(64).optional().describe("Columns in the set image. Default 8."),
      preview: z.boolean().optional().describe("Open a sample map built with the set. Default true."),
      export_dir: z.string().optional().describe("Write <name>.png, <name>.tres, <name>.tsx and <name>.json here."),
      name: z.string().optional().describe("Base name. Default 'terrain'."),
    }),
    kind: "edit",
    label: (a) => `Make ${a.kind ?? 47}-tile set`,
    async run(input, aseprite) {
      const tpl = await pixels(aseprite, input);
      // The template sits at the top-left: 5 tiles of `tile` px.
      let tile = input.tile;
      if (!tile) {
        let bottom = 0;
        for (let y = 0; y < tpl.height; y++) for (let x = 0; x < tpl.width; x++) if (tpl.data[(y * tpl.width + x) * 4 + 3] >= 128) bottom = y + 1;
        tile = bottom;
      }
      if (!tile || tile % 2) return failure(`Couldn't use a tile size of ${tile}: pass an even tile size.`);
      const kind = (input.kind ?? 47) as 47 | 16;
      const ts = buildTileset(tpl, tile, kind, input.columns ?? 8);
      const name = input.name ?? "terrain";
      const made = await aseprite.request("create_sprite", { width: ts.image.width, height: ts.image.height, rgba: send(ts.image), title: `${name} ${kind}-tile set` });
      const lines = [`Made a ${kind}-tile set of ${tile}x${tile} tiles (${ts.columns} columns) as "${made.result.title}".`];
      if (input.preview !== false) {
        const map = renderMap(ts, SAMPLE_MAP, kind);
        await aseprite.request("create_sprite", { width: map.width, height: map.height, rgba: send(map), title: `${name} preview` });
        lines.push(`Opened "${name} preview": a sample map with straight edges, outer and inner corners and a hole. Look at it for seams.`);
      }
      if (input.export_dir) {
        const png = join(input.export_dir, `${name}.png`);
        writePng(png, ts.image);
        writeFileSync(join(input.export_dir, `${name}.tres`), godotTileset(ts, `res://${basename(png)}`, name));
        writeFileSync(join(input.export_dir, `${name}.tsx`), tiledTileset(ts, basename(png), name));
        writeFileSync(join(input.export_dir, `${name}.json`), jsonTileset(ts));
        lines.push(`Exported ${name}.png, .tres (Godot 4: put the PNG at res://${basename(png)} or edit the path), .tsx (Tiled) and .json to ${input.export_dir}.`);
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
  {
    name: "seamless_check",
    title: "Check tile wrap",
    description: "How well a tile (a layer, or a PNG) wraps when repeated: the share of its left/right and top/bottom edge pixels that clash (0% = seamless).",
    input: z.object({ layer: z.string().optional(), frame: z.number().int().min(1).optional(), path: z.string().optional() }),
    kind: "read",
    label: () => "Check tile wrap",
    async run(input, aseprite) {
      const s = seamScore(await pixels(aseprite, input));
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const ok = s.horizontal < 0.1 && s.vertical < 0.1;
      return { content: [text(`Left/right edges clash on ${pct(s.horizontal)} of rows, top/bottom on ${pct(s.vertical)} of columns${ok ? ": it wraps well." : ". Blend the clashing edges so it repeats without a visible seam."}`)] };
    },
  },
];
