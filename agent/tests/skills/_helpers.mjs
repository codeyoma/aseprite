// Shared pieces for the skill evals: a fake document with small, honest
// stand-ins for the extension's color and slice requests, PNG writing,
// temp dirs and pixel helpers. Not an eval itself (no skill has this name).
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDocument, hex, rect } from "../../bridge/test/helpers/fake_document.mjs";
import { resolveFrames } from "../../bridge/dist/document.js";

const require = createRequire(import.meta.url);
export const { PNG } = require("../../bridge/node_modules/pngjs");

export { fakeDocument, hex, rect };

/** A fresh temp dir for one eval's files. */
export const tempDir = (name) => mkdtempSync(join(tmpdir(), `skill-eval-${name}-`));

/** Writes an RGBA image as a PNG. */
export function writePng(path, { width, height, data }) {
  const png = new PNG({ width, height });
  png.data.set(data);
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

/** Nearest-neighbor upscale. */
export function upscale({ width, height, data }, k) {
  const out = new Uint8Array(width * k * height * k * 4);
  for (let y = 0; y < height * k; y++) for (let x = 0; x < width * k; x++) {
    const s = (Math.floor(y / k) * width + Math.floor(x / k)) * 4;
    out.set(data.subarray(s, s + 4), (y * width * k + x) * 4);
  }
  return { width: width * k, height: height * k, data: out };
}

/** Opaque colors in an RGBA buffer as a Set of '#rrggbb'. */
export function colorsOf(data) {
  const s = new Set();
  if (!data) return s;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) s.add(hex(data[i], data[i + 1], data[i + 2]));
  return s;
}

/** Number of opaque pixels. */
export function opaque(data) {
  let n = 0;
  if (data) for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
}

/** The text of a tool result. */
export const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const hex8 = (d, i) => hex(d[i], d[i + 1], d[i + 2], d[i + 3]);
const parse = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(h);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) : 255];
};

/**
 * fakeDocument plus stand-ins for collect_colors, apply_color_map,
 * get_palette, set_palette, split_layer_by_colors and set_slice that work on
 * the fake's own layers the way the extension's handlers do (RGB sprites only).
 */
export function fakeWithColors(opts) {
  let fake;
  const sprite = () => fake.active.sprite;
  const targets = (p) => {
    const s = sprite();
    let layers = s.layers;
    if (p.layer !== undefined) {
      const id = String(p.layer).replace(/^L/, "");
      const l = s.layers.find((x) => String(x.id) === id) ?? s.layers.find((x) => x.name === p.layer);
      if (!l) throw new Error(`Layer not found: ${p.layer}`);
      layers = [l];
    }
    return { layers, frames: resolveFrames(p.frames, s.durations.length, fake.active.frame) };
  };
  const stubs = {
    collect_colors: (p) => {
      const { layers, frames } = targets(p);
      const counts = new Map();
      let pixels = 0;
      for (const l of layers) if (l.visible || p.hidden) for (const f of frames) {
        const d = l.cels[f - 1];
        if (!d) continue;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const k = hex8(d, i); counts.set(k, (counts.get(k) ?? 0) + 1); pixels++; }
      }
      return { colors: [...counts].map(([h, count]) => ({ hex: h, count })).sort((a, b) => b.count - a.count), pixels, colorMode: "rgb" };
    },
    apply_color_map: (p) => {
      const map = new Map(Object.entries(p.map ?? {}).map(([a, b]) => [parse(a).join(), parse(b)]));
      const { layers, frames } = targets(p);
      let changed = 0;
      for (const l of layers) for (const f of frames) {
        const d = l.cels[f - 1];
        if (!d) continue;
        for (let i = 0; i < d.length; i += 4) {
          const to = map.get([d[i], d[i + 1], d[i + 2], d[i + 3]].join());
          if (to) { d.set(to, i); changed++; }
        }
      }
      return { changed, mode: "pixels" };
    },
    get_palette: () => ({ colors: [...sprite().palette] }),
    set_palette: (p) => {
      const s = sprite();
      s.palette = p.append ? [...s.palette, ...p.colors.filter((c) => !s.palette.includes(c))] : [...p.colors];
      return { size: p.colors.length };
    },
    split_layer_by_colors: (p) => {
      const s = sprite();
      const src = p.layer !== undefined ? targets(p).layers[0] : fake.active.layer;
      if (!src) throw new Error("Pick an image layer");
      const groupOf = new Map();
      p.groups.forEach((g, gi) => g.colors.forEach((h) => groupOf.set(parse(h).slice(0, 3).join(), gi)));
      const made = p.groups.map((g) => ({ id: 1000 + s.layers.length + Math.random(), name: g.name, visible: true, cels: [] }));
      let leftover = false;
      src.cels.forEach((d, f) => {
        if (!d) return;
        const rest = new Uint8Array(d);
        for (let i = 0; i < d.length; i += 4) {
          const gi = d[i + 3] ? groupOf.get([d[i], d[i + 1], d[i + 2]].join()) : undefined;
          if (gi === undefined) continue;
          made[gi].cels[f] ??= new Uint8Array(d.length);
          made[gi].cels[f].set(d.subarray(i, i + 4), i);
          rest.fill(0, i, i + 4);
        }
        if (opaque(rest)) leftover = true;
        src.cels[f] = rest;
      });
      // The first group (the outline) ends up on top.
      s.layers.splice(s.layers.indexOf(src) + 1, 0, ...[...made].reverse());
      if (!leftover) s.layers.splice(s.layers.indexOf(src), 1);
      else src.name += " (rest)";
      return { layers: made.map((l) => l.name) };
    },
    set_slice: (p) => {
      const s = sprite();
      s.slices = [...(s.slices ?? []).filter((x) => x.name !== p.name), { ...p }];
      return { slices: s.slices.length };
    },
  };
  fake = fakeDocument({ ...opts, extra: { ...stubs, ...(opts.extra ?? {}) } });
  return fake;
}

/** Bounding box of opaque pixels: { x0, y0, x1, y1, w, h } or undefined. */
export function bounds(data, width) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  if (data) for (let i = 0; i < data.length; i += 4) if (data[i + 3]) {
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? undefined : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
