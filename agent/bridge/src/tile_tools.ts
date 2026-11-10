// Tilesets as tools (#46): build a 47-tile blob or 16-tile autotile set
// from a 5-tile template, preview it on a sample map, export it for
// Godot 4, Tiled and as JSON; check how well a tile wraps.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import { documentOf, type Document } from "./document.js";
import type { Rgba } from "./pixel_grid.js";
import { readPng } from "./sheet_tools.js";
import { buildTileset, godotTileset, jsonTileset, makeSeamless, mapIndices, renderMap, seamScore, templateFrom2x3, tiledTileset } from "./tiles.js";
import { failure, text, type Tool } from "./tool.js";


async function pixels(doc: Document, input: { path?: string; layer?: string; frame?: number }): Promise<Rgba> {
  if (input.path) return readPng(input.path);
  return doc.pixels(input.layer, input.frame);
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

export const TILE_TOOLS: Tool[] = [
  {
    name: "make_autotile",
    title: "Make autotile set",
    description:
      "Build a terrain autotile set from a template at the top-left of a layer (or a PNG). Either 5 tiles in a row: " +
      "1 island (a lone tile: outer corners and edges all around), 2 vertical strip (edges left and right), 3 " +
      "horizontal strip (edges top and bottom), 4 fill (the middle), 5 inner corners (fill with the 4 inner corners); " +
      "or 6 tiles, 2 wide and 3 high (the RPG Maker layout): top left a lone-tile preview, top right the inner corners, " +
      "below them a 2x2 block of terrain with its border. " +
      "Makes the 47-tile blob set (or the 16-tile side-only set) as a new sprite, a preview map on a tilemap layer " +
      "that uses the set as its tileset, and optional exports: " +
      "a Godot 4 TileSet (.tres) with terrain peering bits, a Tiled .tsx wang set, and a JSON bitmask map. Tile size must be even.",
    input: z.object({
      layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      path: z.string().optional().describe("Template PNG instead of a layer."),
      tile: z.number().int().min(4).max(256).optional().describe("Tile size. Default: from the template's size."),
      template: z.enum(["auto", "row", "2x3"]).optional().describe("Template layout: 5 in a row, 6 as 2x3, or auto (default) from its shape."),
      kind: z.union([z.literal(47), z.literal(16)]).optional().describe("Default 47."),
      columns: z.number().int().min(1).max(64).optional().describe("Columns in the set image. Default 8."),
      preview: z.boolean().optional().describe("Open a sample map built with the set, on a tilemap layer. Default true."),
      export_dir: z.string().optional().describe("Write <name>.png, <name>.tres, <name>.tsx and <name>.json here."),
      name: z.string().optional().describe("Base name. Default 'terrain'."),
    }),
    kind: "edit",
    label: (a) => `Make ${a.kind ?? 47}-tile set`,
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      let tpl = await pixels(doc, input);
      // The template sits at the top-left: its drawn size gives the layout and tile size.
      let right = 0, bottom = 0;
      for (let y = 0; y < tpl.height; y++) for (let x = 0; x < tpl.width; x++) {
        if (tpl.data[(y * tpl.width + x) * 4 + 3] >= 128) {
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
      const layout = input.template && input.template !== "auto" ? input.template : right * 3 < bottom * 4 ? "2x3" : "row";
      const tile = input.tile ?? (layout === "2x3" ? Math.round(bottom / 3) : bottom);
      if (!tile || tile % 2) return failure(`Couldn't use a tile size of ${tile}: pass an even tile size.`);
      if (layout === "2x3") tpl = templateFrom2x3(tpl, tile);
      const kind = (input.kind ?? 47) as 47 | 16;
      const ts = buildTileset(tpl, tile, kind, input.columns ?? 8);
      const name = input.name ?? "terrain";
      const made = await doc.createSprite(ts.image, { title: `${name} ${kind}-tile set` });
      const lines = [`Made a ${kind}-tile set of ${tile}x${tile} tiles (${ts.columns} columns) from a ${layout === "2x3" ? "6-tile (2x3)" : "5-tile"} template as "${made.title}".`];
      if (input.preview !== false) {
        try {
          await doc.createTilemap(ts.image, tile, ts.columns, ts.masks.length, mapIndices(ts, SAMPLE_MAP, kind), { title: `${name} preview` });
          lines.push(`Opened "${name} preview": a sample map on a tilemap layer whose tileset is the set (paint more terrain with its tiles), with straight edges, outer and inner corners and a hole. Look at it for seams.`);
        } catch {
          // Aseprite without tilemap layers: a flat picture of the map.
          await doc.createSprite(renderMap(ts, SAMPLE_MAP, kind), { title: `${name} preview` });
          lines.push(`Opened "${name} preview": a sample map with straight edges, outer and inner corners and a hole. Look at it for seams.`);
        }
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
      const s = seamScore(await pixels(documentOf(aseprite), input));
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const ok = s.horizontal < 0.1 && s.vertical < 0.1;
      return { content: [text(`Left/right edges clash on ${pct(s.horizontal)} of rows, top/bottom on ${pct(s.vertical)} of columns${ok ? ": it wraps well." : ". Blend the clashing edges so it repeats without a visible seam."}`)] };
    },
  },
  {
    name: "make_seamless",
    title: "Fix tile seams",
    description:
      "Fix small seams so a tile (a layer, or a PNG) repeats cleanly: where an edge pixel clashes with the opposite " +
      "edge, the rarer color takes the more common one. Only edges where at most max_share clash are touched; a wider " +
      "seam is reported for redrawing. A layer's result goes on 'AI: seamless <layer>' (the original is hidden); a PNG's to out.",
    input: z.object({
      layer: z.string().optional(),
      frame: z.number().int().min(1).optional(),
      path: z.string().optional(),
      out: z.string().optional().describe("Where to write the fixed PNG (path input). Default: next to it, '-seamless'."),
      max_share: z.number().min(0).max(1).optional().describe("Largest share of an edge that may clash and still be fixed. Default 0.25."),
    }),
    kind: "edit",
    label: () => "Fix tile seams",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const tile = await pixels(doc, input);
      const r = makeSeamless(tile, input.max_share ?? 0.25);
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const wide = Object.entries(r.tooWide).map(([axis, v]) => `${axis === "horizontal" ? "left/right" : "top/bottom"} edges clash on ${pct(v!)}, too wide to fix by edge pixels: redraw that seam`);
      if (!r.fixed.horizontal && !r.fixed.vertical) {
        return { content: [text(wide.length ? `Nothing changed: ${wide.join("; ")}.` : "The tile already wraps: nothing to fix.")] };
      }
      let where: string;
      if (input.path) {
        const out = input.out ?? input.path.replace(/(\.png)?$/i, "-seamless.png");
        writePng(out, r.image);
        where = `wrote ${out}`;
      } else {
        const info = await doc.info();
        const layer = input.layer ?? info.layer;
        await doc.putImage(r.image, { newLayer: `seamless ${layer}`, above: layer, hideSource: true, frame: input.frame });
        where = `on 'AI: seamless ${layer}' (the original is hidden)`;
      }
      return { content: [text(`Fixed ${r.fixed.horizontal} left/right and ${r.fixed.vertical} top/bottom seam pixels, ${where}.${wide.length ? ` Still: ${wide.join("; ")}.` : ""}`)] };
    },
  },
];
