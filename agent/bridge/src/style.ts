// Reading how a sprite is built (#40): its outline, shading bands,
// dithering and palette, and which colors play which role, so a
// reference can be recreated as editable layers and new art can follow
// its style.
import { hex, ramps, toOklch, type Counted, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";

const at = (img: Rgba, x: number, y: number) => (y * img.width + x) * 4;
const isOpaque = (img: Rgba, x: number, y: number) =>
  x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[at(img, x, y) + 3] >= 128;
const colorAt = (img: Rgba, x: number, y: number): RGBA => {
  const i = at(img, x, y);
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: 255 };
};

export { countColors } from "./image.js";
import { countColors } from "./image.js";

export interface Outline {
  present: boolean;
  /** The outline colors (hex), darkest first. */
  colors: string[];
  /** Share of edge pixels (next to transparency) that use an outline color. */
  coverage: number;
  /** "dark" (one dark color), "selout" (darker shades of the fill they border) or "none". */
  kind: "dark" | "selout" | "none";
}

/**
 * The outline: colors of opaque pixels next to transparency. A single
 * dark color covering most of the edge is a classic outline; several
 * colors that are each darker than the fill beside them is "selout".
 */
export function findOutline(img: Rgba): Outline {
  const edge = new Map<string, number>();
  let edgeTotal = 0;
  const inner = new Map<string, Map<string, number>>(); // edge color -> neighboring inner colors
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!isOpaque(img, x, y)) continue;
      const touches = !isOpaque(img, x - 1, y) || !isOpaque(img, x + 1, y) || !isOpaque(img, x, y - 1) || !isOpaque(img, x, y + 1);
      if (!touches) continue;
      const k = hex(colorAt(img, x, y));
      edge.set(k, (edge.get(k) ?? 0) + 1);
      edgeTotal++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isOpaque(img, x + dx, y + dy)) continue;
        const n = hex(colorAt(img, x + dx, y + dy));
        if (n === k) continue;
        const m = inner.get(k) ?? new Map<string, number>();
        m.set(n, (m.get(n) ?? 0) + 1);
        inner.set(k, m);
      }
    }
  }
  if (!edgeTotal) return { present: false, colors: [], coverage: 0, kind: "none" };
  const L = (h: string) => toOklch(parse(h)).L;
  const sorted = [...edge.entries()].sort((a, b) => b[1] - a[1]);
  // A dominant dark edge color.
  const [topColor, topN] = sorted[0];
  if (topN / edgeTotal >= 0.6 && L(topColor) < 0.4) {
    return { present: true, colors: [topColor], coverage: topN / edgeTotal, kind: "dark" };
  }
  // Selout: edge colors that are darker than the inner colors they touch.
  const darker = sorted.filter(([c]) => {
    const n = inner.get(c);
    if (!n) return false;
    const main = [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return L(c) < L(main) - 0.05;
  });
  const cov = darker.reduce((s, [, n]) => s + n, 0) / edgeTotal;
  if (cov >= 0.6) {
    return { present: true, colors: darker.map(([c]) => c).sort((a, b) => L(a) - L(b)), coverage: cov, kind: "selout" };
  }
  return { present: false, colors: [], coverage: 0, kind: "none" };
}

function parse(h: string): RGBA {
  const v = parseInt(h.slice(1, 7), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 255 };
}

/** Share of opaque pixels that sit in a 2x2 checker of two alternating colors (dithering). */
export function ditherShare(img: Rgba): number {
  let checker = 0, total = 0;
  for (let y = 0; y + 1 < img.height; y++) {
    for (let x = 0; x + 1 < img.width; x++) {
      if (!isOpaque(img, x, y) || !isOpaque(img, x + 1, y) || !isOpaque(img, x, y + 1) || !isOpaque(img, x + 1, y + 1)) continue;
      total++;
      const a = hex(colorAt(img, x, y)), b = hex(colorAt(img, x + 1, y));
      if (a !== b && hex(colorAt(img, x + 1, y + 1)) === a && hex(colorAt(img, x, y + 1)) === b) checker++;
    }
  }
  return total ? checker / total : 0;
}

export interface Style {
  width: number;
  height: number;
  colors: number;
  ramps: { name: string; steps: number; colors: string[] }[];
  outline: Outline;
  dithering: number;
  /** Plain-language rules to follow when drawing in this style. */
  rules: string[];
}

/** How a sprite is built, with rules for drawing new art in its style. */
export function analyzeStyle(img: Rgba): Style {
  const colors = countColors(img);
  const outline = findOutline(img);
  const fill = colors.filter((c) => !outline.colors.includes(hex(c)));
  const rs = ramps(fill).map((r) => ({ name: r.name, steps: r.colors.length, colors: r.colors.map(hex) }));
  const dithering = ditherShare(img);
  const bands = rs.length ? Math.round(rs.reduce((s, r) => s + r.steps, 0) / rs.length) : 0;
  const rules = [
    `Size about ${img.width}x${img.height} px; keep new sprites at this scale.`,
    `Use only these ${colors.length} colors (set them as the palette).`,
    outline.kind === "dark" ? `Outline every shape with ${outline.colors[0]}, 1 px.`
      : outline.kind === "selout" ? "Outline with a darker shade of the color each edge borders (selout), not one dark color."
      : "No outline: shapes end in their own colors.",
    bands ? `Shade with about ${bands} steps per color ramp (${rs.map((r) => `${r.name} ${r.steps}`).join(", ")}).` : "Flat colors, no shading ramps.",
    dithering > 0.05 ? "Uses dithering (checker patterns) for transitions." : "No dithering: hard steps between shades.",
  ];
  return { width: img.width, height: img.height, colors: colors.length, ramps: rs, outline, dithering, rules };
}

/**
 * Color roles for splitting a sprite into editable layers: the outline
 * colors on one layer, each ramp on its own layer (named by hue).
 */
export function colorGroups(img: Rgba): { name: string; colors: string[] }[] {
  const s = analyzeStyle(img);
  const groups: { name: string; colors: string[] }[] = [];
  if (s.outline.present) groups.push({ name: "Outline", colors: s.outline.colors });
  const used = new Set<string>();
  for (const r of s.ramps) {
    let name = r.name[0].toUpperCase() + r.name.slice(1);
    while (used.has(name)) name += "+";
    used.add(name);
    groups.push({ name, colors: r.colors });
  }
  return groups;
}
