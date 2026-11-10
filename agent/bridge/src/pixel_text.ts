// Writable pixel grid (#74): checks the rows and legend an agent passes to
// write_pixels before anything is sent to Aseprite, in the format read_pixels
// returns (keys separated by spaces, '.' transparent, '-' unchanged). The
// extension (document_handlers.lua write_pixels) checks again with the sprite
// at hand: palette indexes, palette membership in indexed sprites, the canvas.
//
// Adapted from aseprite-ai-artist's PixelGrid (src/lib/grid.ts, MIT License,
// Copyright (c) 2026 with-pebbly, https://github.com/with-pebbly/aseprite-ai-artist):
// the strict, located errors for ragged rows and unknown keys. Here the grid
// is checked, not compiled: Aseprite writes it in one transaction.

/** A grid ready for the wire: rows of keys joined by single spaces, and the legend as key -> hex. */
export interface PixelGrid {
  rows: string[];
  legend: Record<string, string>;
  width: number;
  height: number;
}

export const MAX_GRID_PIXELS = 128 * 128;
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i;
/** The row label read_pixels prints in front of each row (" 9| "), dropped when an agent copies it along. */
const ROW_LABEL = /^\s*-?\d+\|\s?/;

/**
 * A legend as an object, or as the "Legend:" line read_pixels prints ("0=#ff0000  1=#00ff00",
 * with or without the "Legend:" prefix). "(none)" is an empty legend.
 */
export function parseLegend(legend: Record<string, string> | string | undefined): Record<string, string> {
  if (legend === undefined) return {};
  let entries: [string, string][];
  if (typeof legend === "string") {
    const body = legend.replace(/^\s*Legend:\s*/i, "").trim();
    if (body === "" || body === "(none)") return {};
    entries = body.split(/\s+/).map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`Legend entry '${part}' is not key=#rrggbb`);
      return [part.slice(0, eq), part.slice(eq + 1)];
    });
  } else entries = Object.entries(legend);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k === "." || k === "-") throw new Error(`Legend key '${k}' is reserved: '.' is transparent and '-' leaves a pixel unchanged`);
    if (/\s/.test(k) || k === "") throw new Error(`Legend key '${k}' must be one word without spaces`);
    if (typeof v !== "string" || !HEX.test(v)) throw new Error(`Legend key '${k}': ${String(v)} is not a color (use #rrggbb or #rrggbbaa)`);
    out[k] = (v.startsWith("#") ? v : `#${v}`).toLowerCase();
  }
  return out;
}

/**
 * Checks rows against the legend: every row the same number of keys, every key '.', '-', a legend key,
 * a '#hex' color or a number (a palette index in an indexed sprite; the extension decides). Errors name
 * the row and column (1-based) and the sprite pixel. Rows are never padded or cut.
 */
export function parseGrid(rows: string[], legendIn: Record<string, string> | string | undefined, x0 = 0, y0 = 0): PixelGrid {
  const legend = parseLegend(legendIn);
  if (!rows.length) throw new Error("rows must list at least one row");
  const grid = rows.map((row) => row.replace(ROW_LABEL, "").trim().split(/\s+/).filter(Boolean));
  const width = grid[0].length;
  if (!width) throw new Error("Row 1 is empty");
  grid.forEach((cells, r) => {
    if (cells.length !== width) {
      throw new Error(`Row ${r + 1} (y=${y0 + r}) has ${cells.length} pixels but row 1 has ${width}. ` +
        "Every row must be the same width; rows are never padded");
    }
    cells.forEach((t, c) => {
      if (t === "." || t === "-" || Object.hasOwn(legend, t) || /^\d+$/.test(t) || HEX.test(t) && t.startsWith("#")) return;
      throw new Error(`Row ${r + 1}, column ${c + 1} (x=${x0 + c}, y=${y0 + r}): unknown key '${t}'; add it to the legend or use '.' for transparent`);
    });
  });
  if (width * grid.length > MAX_GRID_PIXELS) {
    throw new Error(`Grid ${width}x${grid.length} is too large; write at most ${MAX_GRID_PIXELS} pixels per call`);
  }
  return { rows: grid.map((cells) => cells.join(" ")), legend, width, height: grid.length };
}
