// Seeded coherent noise for the effect pipelines and particle motion (#107), written from the papers (no code
// copied): value noise (a lattice of random values, quintic interpolation); Perlin's improved noise ("Improving
// Noise", SIGGRAPH 2002: a permutation table, gradients at lattice points, the 6t^5 - 15t^4 + 10t^3 fade);
// simplex noise (Perlin 2001, as explained in Gustavson's "Simplex noise demystified", 2005, and his 2012 rank
// method for 4D); and Worley's cellular noise ("A Cellular Texture Basis Function", 1996: distance to the nearest
// of one jittered feature point per cell, F1). Every kind exists in 2D, 3D and 4D, so an animation can loop: a 2D
// field animated over a loop samples 4D noise at (x, y, r cos 2πφ, r sin 2πφ), a circle in the two extra
// dimensions, so phase 1 is phase 0 exactly. fBm sums octaves. Values are in about [-1, 1]; same seed, same field.

export type NoiseKind = "value" | "perlin" | "simplex" | "worley";
export const NOISE_KINDS: NoiseKind[] = ["value", "perlin", "simplex", "worley"];

const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3, G3 = 1 / 6;
const F4 = (Math.sqrt(5) - 1) / 4, G4 = (5 - Math.sqrt(5)) / 20;

/** The 12 edge midpoints of a cube (Perlin 2002), the gradients of 2D and 3D simplex noise. */
const GRAD3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
/** The 32 edge midpoints of a 4D hypercube: permutations of (0, ±1, ±1, ±1). */
const GRAD4: number[][] = [];
for (let zero = 0; zero < 4; zero++) for (let s = 0; s < 8; s++) {
  const v: number[] = [], signs = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
  for (let k = 0, j = 0; k < 4; k++) v.push(k === zero ? 0 : signs[j++]);
  GRAD4.push(v);
}
/** Eight unit-ish directions for 2D Perlin noise. */
const GRAD2 = [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** mulberry32: the seeded generator that shuffles the tables. */
function mulberry(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded noise source: one permutation table and value tables, shared by every kind and dimension. */
export class Noise {
  readonly seed: number;
  private p = new Uint8Array(512);
  /** Lattice values in [-1, 1] (value noise) and jitters in [0, 1) (Worley's feature points), by hash. */
  private v = new Float64Array(256);
  private j = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];

  constructor(seed = 1) {
    this.seed = seed;
    const r = mulberry(seed * 2654435761 + 1);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const k = Math.floor(r() * (i + 1));
      [perm[i], perm[k]] = [perm[k], perm[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    for (let i = 0; i < 256; i++) {
      this.v[i] = r() * 2 - 1;
      for (const t of this.j) t[i] = r();
    }
  }

  private h2(i: number, j: number) { const p = this.p; return p[(p[i & 255] + j) & 255]; }
  private h3(i: number, j: number, k: number) { const p = this.p; return p[(p[(p[i & 255] + j) & 255] + k) & 255]; }
  private h4(i: number, j: number, k: number, l: number) { const p = this.p; return p[(p[(p[(p[i & 255] + j) & 255] + k) & 255] + l) & 255]; }

  // ---- value noise
  value2(x: number, y: number): number {
    const i = Math.floor(x), j = Math.floor(y), u = fade(x - i), w = fade(y - j), v = this.v;
    return lerp(lerp(v[this.h2(i, j)], v[this.h2(i + 1, j)], u), lerp(v[this.h2(i, j + 1)], v[this.h2(i + 1, j + 1)], u), w);
  }
  value3(x: number, y: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), u = fade(x - i), w = fade(y - j), s = fade(z - k), v = this.v;
    const plane = (kk: number) => lerp(lerp(v[this.h3(i, j, kk)], v[this.h3(i + 1, j, kk)], u), lerp(v[this.h3(i, j + 1, kk)], v[this.h3(i + 1, j + 1, kk)], u), w);
    return lerp(plane(k), plane(k + 1), s);
  }
  value4(x: number, y: number, z: number, q: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), l = Math.floor(q);
    const u = fade(x - i), w = fade(y - j), s = fade(z - k), r = fade(q - l), v = this.v;
    const plane = (kk: number, ll: number) => lerp(lerp(v[this.h4(i, j, kk, ll)], v[this.h4(i + 1, j, kk, ll)], u), lerp(v[this.h4(i, j + 1, kk, ll)], v[this.h4(i + 1, j + 1, kk, ll)], u), w);
    return lerp(lerp(plane(k, l), plane(k + 1, l), s), lerp(plane(k, l + 1), plane(k + 1, l + 1), s), r);
  }

  // ---- Perlin's improved noise
  perlin2(x: number, y: number): number {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fade(fx), w = fade(fy);
    const g = (ii: number, jj: number, dx: number, dy: number) => { const d = GRAD2[this.h2(ii, jj) & 7]; return d[0] * dx + d[1] * dy; };
    return lerp(lerp(g(i, j, fx, fy), g(i + 1, j, fx - 1, fy), u), lerp(g(i, j + 1, fx, fy - 1), g(i + 1, j + 1, fx - 1, fy - 1), u), w) * 1.41;
  }
  perlin3(x: number, y: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
    const u = fade(fx), w = fade(fy), s = fade(fz);
    const g = (ii: number, jj: number, kk: number, dx: number, dy: number, dz: number) => {
      const d = GRAD3[this.h3(ii, jj, kk) % 12];
      return d[0] * dx + d[1] * dy + d[2] * dz;
    };
    const plane = (kk: number, dz: number) => lerp(lerp(g(i, j, kk, fx, fy, dz), g(i + 1, j, kk, fx - 1, fy, dz), u),
      lerp(g(i, j + 1, kk, fx, fy - 1, dz), g(i + 1, j + 1, kk, fx - 1, fy - 1, dz), u), w);
    return lerp(plane(k, fz), plane(k + 1, fz - 1), s);
  }
  perlin4(x: number, y: number, z: number, q: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), l = Math.floor(q);
    const fx = x - i, fy = y - j, fz = z - k, fq = q - l, u = fade(fx), w = fade(fy), s = fade(fz), r = fade(fq);
    const g = (ii: number, jj: number, kk: number, ll: number, dx: number, dy: number, dz: number, dq: number) => {
      const d = GRAD4[this.h4(ii, jj, kk, ll) & 31];
      return d[0] * dx + d[1] * dy + d[2] * dz + d[3] * dq;
    };
    const plane = (kk: number, ll: number, dz: number, dq: number) => lerp(
      lerp(g(i, j, kk, ll, fx, fy, dz, dq), g(i + 1, j, kk, ll, fx - 1, fy, dz, dq), u),
      lerp(g(i, j + 1, kk, ll, fx, fy - 1, dz, dq), g(i + 1, j + 1, kk, ll, fx - 1, fy - 1, dz, dq), u), w);
    return lerp(lerp(plane(k, l, fz, fq), plane(k + 1, l, fz - 1, fq), s), lerp(plane(k, l + 1, fz, fq - 1), plane(k + 1, l + 1, fz - 1, fq - 1), s), r) * 0.8;
  }

  // ---- simplex noise (Gustavson 2005; 4D by ranking, 2012)
  simplex2(x: number, y: number): number {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const c = (dx: number, dy: number, h: number) => {
      const r = 0.5 - dx * dx - dy * dy;
      if (r < 0) return 0;
      const g = GRAD3[h % 12];
      return r * r * r * r * (g[0] * dx + g[1] * dy);
    };
    return 70 * (c(x0, y0, this.h2(i, j)) + c(x1, y1, this.h2(i + i1, j + j1)) + c(x2, y2, this.h2(i + 1, j + 1)));
  }
  simplex3(x: number, y: number, z: number): number {
    const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else {
      if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
      else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    }
    const c = (dx: number, dy: number, dz: number, h: number) => {
      const r = 0.6 - dx * dx - dy * dy - dz * dz;
      if (r < 0) return 0;
      const g = GRAD3[h % 12];
      return r * r * r * r * (g[0] * dx + g[1] * dy + g[2] * dz);
    };
    return 32 * (
      c(x0, y0, z0, this.h3(i, j, k)) +
      c(x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3, this.h3(i + i1, j + j1, k + k1)) +
      c(x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3, this.h3(i + i2, j + j2, k + k2)) +
      c(x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3, this.h3(i + 1, j + 1, k + 1)));
  }
  simplex4(x: number, y: number, z: number, w: number): number {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), l = Math.floor(w + s), t = (i + j + k + l) * G4;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t), w0 = w - (l - t);
    // Rank the coordinates: the largest steps first along the simplex.
    let rx = 0, ry = 0, rz = 0, rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;
    const c = (dx: number, dy: number, dz: number, dw: number, h: number) => {
      const r = 0.6 - dx * dx - dy * dy - dz * dz - dw * dw;
      if (r < 0) return 0;
      const g = GRAD4[h & 31];
      return r * r * r * r * (g[0] * dx + g[1] * dy + g[2] * dz + g[3] * dw);
    };
    let sum = c(x0, y0, z0, w0, this.h4(i, j, k, l));
    for (let n = 1; n <= 3; n++) {
      const a = rx >= 4 - n ? 1 : 0, b = ry >= 4 - n ? 1 : 0, cc = rz >= 4 - n ? 1 : 0, d = rw >= 4 - n ? 1 : 0;
      sum += c(x0 - a + n * G4, y0 - b + n * G4, z0 - cc + n * G4, w0 - d + n * G4, this.h4(i + a, j + b, k + cc, l + d));
    }
    sum += c(x0 - 1 + 4 * G4, y0 - 1 + 4 * G4, z0 - 1 + 4 * G4, w0 - 1 + 4 * G4, this.h4(i + 1, j + 1, k + 1, l + 1));
    return 27 * sum;
  }

  // ---- Worley (cellular) noise: F1, the distance to the nearest feature point, mapped to [-1, 1]
  worley2(x: number, y: number): number {
    const i = Math.floor(x), j = Math.floor(y), J = this.j;
    let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const h = this.h2(i + a, j + b), dx = i + a + J[0][h] - x, dy = j + b + J[1][h] - y;
      best = Math.min(best, dx * dx + dy * dy);
    }
    return Math.min(1, Math.sqrt(best)) * 2 - 1;
  }
  worley3(x: number, y: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), J = this.j;
    let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const h = this.h3(i + a, j + b, k + c);
      const dx = i + a + J[0][h] - x, dy = j + b + J[1][h] - y, dz = k + c + J[2][h] - z;
      best = Math.min(best, dx * dx + dy * dy + dz * dz);
    }
    return Math.min(1, Math.sqrt(best)) * 2 - 1;
  }
  worley4(x: number, y: number, z: number, w: number): number {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), l = Math.floor(w), J = this.j;
    let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (let d = -1; d <= 1; d++) {
      const h = this.h4(i + a, j + b, k + c, l + d);
      const dx = i + a + J[0][h] - x, dy = j + b + J[1][h] - y, dz = k + c + J[2][h] - z, dw = l + d + J[3][h] - w;
      best = Math.min(best, dx * dx + dy * dy + dz * dz + dw * dw);
    }
    return Math.min(1, Math.sqrt(best)) * 2 - 1;
  }

  /** One sample of `kind` in 2D, 3D or 4D (by how many coordinates are given). */
  sample(kind: NoiseKind, x: number, y: number, z?: number, w?: number): number {
    if (w !== undefined) {
      switch (kind) {
        case "value": return this.value4(x, y, z ?? 0, w);
        case "perlin": return this.perlin4(x, y, z ?? 0, w);
        case "simplex": return this.simplex4(x, y, z ?? 0, w);
        case "worley": return this.worley4(x, y, z ?? 0, w);
      }
    }
    if (z !== undefined) {
      switch (kind) {
        case "value": return this.value3(x, y, z);
        case "perlin": return this.perlin3(x, y, z);
        case "simplex": return this.simplex3(x, y, z);
        case "worley": return this.worley3(x, y, z);
      }
    }
    switch (kind) {
      case "value": return this.value2(x, y);
      case "perlin": return this.perlin2(x, y);
      case "simplex": return this.simplex2(x, y);
      case "worley": return this.worley2(x, y);
    }
  }
}

export interface FbmOptions {
  /** Octaves summed (1 = plain noise). */
  octaves?: number;
  /** Frequency multiplier per octave. Default 2. */
  lacunarity?: number;
  /** Amplitude multiplier per octave. Default 0.5. */
  gain?: number;
}

/**
 * Fractal Brownian motion: octaves of `kind` at rising frequency and falling amplitude, normalized to about [-1, 1].
 * Every coordinate is scaled per octave, so a loop's circle stays a closed circle and fBm loops too. Each octave is
 * offset so the octaves do not line up at the origin.
 */
export function fbm(n: Noise, kind: NoiseKind, x: number, y: number, z?: number, w?: number, o: FbmOptions = {}): number {
  const octaves = Math.max(1, Math.min(8, Math.round(o.octaves ?? 1))), lac = o.lacunarity ?? 2, gain = o.gain ?? 0.5;
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let k = 0; k < octaves; k++) {
    const off = k * 19.19;
    sum += amp * n.sample(kind, x * f + off, y * f - off, z === undefined ? undefined : z * f + off, w === undefined ? undefined : w * f - off);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

/**
 * Looping noise: (x, y) at loop phase φ (0..1), sampled on a circle of `radius` in two extra dimensions, so
 * φ = 1 gives exactly what φ = 0 gives. A larger radius changes more over the loop.
 */
export function loopNoise(n: Noise, kind: NoiseKind, x: number, y: number, phase: number, radius = 1, o: FbmOptions = {}): number {
  const a = phase * 2 * Math.PI;
  return fbm(n, kind, x, y, Math.cos(a) * radius, Math.sin(a) * radius, o);
}

/** Where noise is sampled in time: still, moving through a third dimension, or around a loop. */
export interface NoiseTime {
  /** Normalized time of the effect, 0..1. */
  t: number;
  /** Sample around a loop (t is then the loop phase). */
  loop?: boolean;
  /** How far the field travels over the effect (0: still). */
  speed?: number;
}

/** A field value in [-1, 1] at pixel (x, y): noise of feature size `scale` px, moving by `time`. */
export function field(n: Noise, kind: NoiseKind, x: number, y: number, scale: number, time: NoiseTime = { t: 0 }, o: FbmOptions = {}): number {
  const s = Math.max(0.25, scale), u = x / s, v = y / s, speed = time.speed ?? 0;
  if (!speed) return fbm(n, kind, u, v, undefined, undefined, o);
  // Around a loop the circle's circumference is `speed` noise cells, the same distance a one-shot travels.
  if (time.loop) return loopNoise(n, kind, u, v, time.t, speed / (2 * Math.PI), o);
  return fbm(n, kind, u, v, time.t * speed, undefined, o);
}

/** Curl of the noise potential ψ(x, y, z) by central differences (Bridson et al. 2007): (∂ψ/∂y, -∂ψ/∂x), divergence-free. */
export function curl2(n: Noise, kind: NoiseKind, x: number, y: number, z: number, eps = 0.01): [number, number] {
  const dy = (n.sample(kind, x, y + eps, z) - n.sample(kind, x, y - eps, z)) / (2 * eps);
  const dx = (n.sample(kind, x + eps, y, z) - n.sample(kind, x - eps, y, z)) / (2 * eps);
  return [dy, -dx];
}
