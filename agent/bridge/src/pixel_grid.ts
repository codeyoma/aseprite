// Pixel snap (#37): turn upscaled or AI-generated "pixel art" (an irregular
// or scaled grid, blended edges, drifting colors) back into real pixel art
// at its native size. Detect the grid from where colors change, then take
// one color per cell.

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Buffer; // RGBA, row-major
}

export interface Grid {
  /** Cell size in source pixels along x and y (1 = already native; may be fractional). */
  cellX: number;
  cellY: number;
  /** Where the first full cell starts (0..cell-1). */
  offsetX: number;
  offsetY: number;
  /** How clearly the grid stands out (0..1). */
  confidence: number;
}

/**
 * Changes smaller than this (sum over R, G, B) are noise: JPEG artifacts
 * and generator grain inside flat areas, which would otherwise drown the
 * real color changes at cell boundaries.
 */
export const NOISE_FLOOR = 40;

/** Color change between neighboring pixels (RGB distance above the noise floor). */
function diff(d: Uint8Array | Buffer, i: number, j: number): number {
  const aa = d[i + 3], ab = d[j + 3];
  if (aa < 128 && ab < 128) return 0;
  if ((aa < 128) !== (ab < 128)) return 255;
  const v = Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
  return v < NOISE_FLOOR ? 0 : v;
}

/**
 * Edge profiles: how much color changes across each column boundary x
 * (between x-1 and x) and each row boundary y, summed over the image.
 */
export function edgeProfiles(img: Rgba): { cols: Float64Array; rows: Float64Array } {
  const { width: w, height: h, data } = img;
  const cols = new Float64Array(w);
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) cols[x] += diff(data, (y * w + x - 1) * 4, (y * w + x) * 4);
  }
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) rows[y] += diff(data, ((y - 1) * w + x) * 4, (y * w + x) * 4);
  }
  return { cols, rows };
}

/** Share of all change on boundaries round(o + k*c), corrected for chance. */
function gridScore(profile: Float64Array, total: number, c: number, o: number): number {
  const n = profile.length;
  let on = 0, count = 0;
  for (let k = 0; ; k++) {
    const i = Math.round(o + k * c);
    if (i >= n) break;
    if (i >= 1) {
      on += profile[i];
      count++;
    }
  }
  if (count < 2) return -1;
  const chance = count / n;
  return (on / total - chance) / (1 - chance);
}

/**
 * The period of a profile: the cell size c (fractional allowed: AI images
 * and odd scales give cells like 5.5 px) and offset o whose boundaries
 * round(o + k*c) carry the most of all the color change, against chance.
 * Divisors of the true cell catch every edge too, and multiples catch only
 * some, so the answer is the largest c scoring close to the best, then the
 * best-scoring c near it.
 */
export function period(profile: Float64Array, maxCell = Math.min(64, Math.floor(profile.length / 3))): { cell: number; offset: number; confidence: number } {
  const n = profile.length;
  let total = 0;
  for (let i = 1; i < n; i++) total += profile[i];
  if (total === 0) return { cell: 1, offset: 0, confidence: 0 };
  const scores: { cell: number; offset: number; score: number }[] = [];
  for (let c = 2; c <= Math.max(2, maxCell) + 1e-9; c += 0.05) {
    let best = { offset: 0, score: -Infinity };
    // Whole cells need only whole offsets.
    const whole = Math.abs(c - Math.round(c)) < 1e-6;
    for (let o = 0; o < c - 1e-9; o += whole ? 1 : 0.25) {
      const sc = gridScore(profile, total, whole ? Math.round(c) : c, o);
      if (sc > best.score) best = { offset: o, score: sc };
    }
    scores.push({ cell: Math.round(c * 100) / 100, offset: best.offset, score: best.score });
  }
  const top = Math.max(...scores.map((x) => x.score));
  // Native art: no spacing explains the changes much better than chance.
  if (top < 0.45) return { cell: 1, offset: 0, confidence: 1 - Math.max(0, top) };
  const largest = scores.filter((x) => x.score >= top * 0.85).sort((a, b) => b.cell - a.cell)[0];
  const near = scores.filter((x) => Math.abs(x.cell - largest.cell) <= 0.5);
  // Prefer whole cells when they score as well (clean upscales).
  const pick = near.sort((a, b) => b.score - a.score || Number(Number.isInteger(b.cell)) - Number(Number.isInteger(a.cell)))[0];
  return { cell: pick.cell, offset: pick.offset, confidence: Math.min(1, pick.score) };
}

export function detectGrid(img: Rgba, maxCell?: number): Grid {
  const { cols, rows } = edgeProfiles(img);
  const x = period(cols, maxCell);
  const y = period(rows, maxCell);
  // Pixel art cells are square: if one axis is unclear, use the other.
  let cellX = x.cell, cellY = y.cell, offsetX = x.offset, offsetY = y.offset;
  if (cellX === 1 && cellY > 1 && y.confidence > 0.3) {
    cellX = cellY;
    offsetX = period(cols, cellY).offset;
  } else if (cellY === 1 && cellX > 1 && x.confidence > 0.3) {
    cellY = cellX;
    offsetY = period(rows, cellX).offset;
  }
  return { cellX, cellY, offsetX, offsetY, confidence: Math.min(x.confidence, y.confidence) };
}

/**
 * One color per cell: the most common color in the cell's middle (edges
 * blend with neighbors), with near-equal colors (after JPEG noise) pooled
 * and averaged. Alpha becomes 0 or 255. Partial cells at the borders count
 * when at least half a cell is inside the image.
 */
export function resample(img: Rgba, g: Grid): Rgba {
  const { width: w, height: h, data } = img;
  const startX = g.offsetX >= g.cellX / 2 ? g.offsetX - g.cellX : g.offsetX;
  const startY = g.offsetY >= g.cellY / 2 ? g.offsetY - g.cellY : g.offsetY;
  const ow = Math.max(1, Math.ceil((w - startX - g.cellX / 2) / g.cellX));
  const oh = Math.max(1, Math.ceil((h - startY - g.cellY / 2) / g.cellY));
  const out = new Uint8Array(ow * oh * 4);
  const mx = Math.floor(g.cellX / 4), my = Math.floor(g.cellY / 4);
  for (let cy = 0; cy < oh; cy++) {
    for (let cx = 0; cx < ow; cx++) {
      // Cell bounds (fractional cells round to pixel boundaries), minus a margin.
      const cx0 = Math.round(startX + cx * g.cellX), cx1 = Math.round(startX + (cx + 1) * g.cellX);
      const cy0 = Math.round(startY + cy * g.cellY), cy1 = Math.round(startY + (cy + 1) * g.cellY);
      let x0 = Math.max(0, cx0 + mx), x1 = Math.min(w, cx1 - mx);
      let y0 = Math.max(0, cy0 + my), y1 = Math.min(h, cy1 - my);
      if (x1 <= x0) { x0 = Math.max(0, Math.min(w - 1, cx0)); x1 = x0 + 1; }
      if (y1 <= y0) { y0 = Math.max(0, Math.min(h - 1, cy0)); y1 = y0 + 1; }
      const buckets = new Map<number, { n: number; r: number; g: number; b: number; a: number }>();
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const a = data[i + 3] >= 128 ? 255 : 0;
          // Pool colors that differ only by noise.
          const key = a ? ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4) : -1;
          const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, a };
          e.n++;
          e.r += data[i];
          e.g += data[i + 1];
          e.b += data[i + 2];
          buckets.set(key, e);
        }
      }
      let best: { n: number; r: number; g: number; b: number; a: number } | undefined;
      for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
      const o = (cy * ow + cx) * 4;
      if (best && best.a) {
        out[o] = Math.round(best.r / best.n);
        out[o + 1] = Math.round(best.g / best.n);
        out[o + 2] = Math.round(best.b / best.n);
        out[o + 3] = 255;
      }
    }
  }
  return { width: ow, height: oh, data: out };
}

/** Nearest-neighbor scale by a possibly fractional factor (tests, previews). */
export function scaleBy(img: Rgba, f: number, padX = 0, padY = 0): Rgba {
  const w = Math.round(img.width * f) + padX, h = Math.round(img.height * f) + padY;
  const out = new Uint8Array(w * h * 4);
  for (let y = padY; y < h; y++) {
    for (let x = padX; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x - padX) / f)), sy = Math.min(img.height - 1, Math.floor((y - padY) / f));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

/** Removes fully transparent rows and columns around the content. */
export function trim(img: Rgba): Rgba & { x: number; y: number } {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { ...img, x: 0, y: 0 };
  const ow = x1 - x0 + 1, oh = y1 - y0 + 1;
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * ow * 4);
  }
  return { width: ow, height: oh, data: out, x: x0, y: y0 };
}

/** Nearest-neighbor upscale (tests and previews). */
export function upscale(img: Rgba, s: number, padX = 0, padY = 0): Rgba {
  const w = img.width * s + padX, h = img.height * s + padY;
  const out = new Uint8Array(w * h * 4);
  for (let y = padY; y < h; y++) {
    for (let x = padX; x < w; x++) {
      const sx = Math.floor((x - padX) / s), sy = Math.floor((y - padY) / s);
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
