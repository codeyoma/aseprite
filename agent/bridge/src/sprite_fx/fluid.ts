// Pixel-art fluids (#106): a small-grid gas solver for smoke, fire, gas and steam, a PIC/FLIP liquid solver for
// splashes and pours, and the shading that turns their fields into palette pixels.
//
// Implemented from the papers, no code copied: Stam, "Stable Fluids" (1999) and "Real-Time Fluid Dynamics for
// Games" (2003) for semi-Lagrangian advection and the pressure projection; Harlow & Welch (1965) for the staggered
// (MAC) grid both solvers use, which makes the discrete divergence exactly the one the projection removes; Fedkiw,
// Stam & Jensen, "Visual Simulation of Smoke" (2001) for vorticity confinement and temperature buoyancy; Nguyen,
// Fedkiw & Jensen (2002) for the fuel -> heat -> smoke model with cooling; Brackbill & Ruppel (1986) and Zhu &
// Bridson (2005) for FLIP and the PIC/FLIP blend; Bridson's course notes for the particle density correction.
// The projection is Gauss-Seidel with over-relaxation directly on the face velocities.
//
// Everything is deterministic: a fixed timestep, a seeded PRNG, and loops in a fixed order. Units: canvas pixels
// and seconds at the interface; the solvers work in grid cells (resolution cells a pixel) and scale by it.
import type { RGBA } from "../color.js";
import { BAYER4 } from "../dither.js";
import type { Rgba } from "../image.js";

/** A small seeded PRNG (mulberry32): [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Side = "wall" | "open";
export interface Sides { left: Side; right: Side; top: Side; bottom: Side }
export const WALLS: Sides = { left: "wall", right: "wall", top: "wall", bottom: "wall" };

// ---------------------------------------------------------------------------------------------------------------
// Gas: smoke, fire, poison gas, steam.

/** What drives a gas step, in grid units (cells, seconds). */
export interface GasForces {
  /** Upward acceleration per unit of temperature. */
  buoyancy: number;
  /** Downward acceleration per unit of density (heavy gas). */
  weight: number;
  /** Vorticity confinement strength (Fedkiw's epsilon times the cell size). */
  vorticity: number;
  /** A uniform background flow added to the advecting velocity (cells/s). */
  windX: number;
  windY: number;
  /** Per-second decay rates of density and temperature. */
  dissipation: number;
  cooling: number;
  /** Fuel burnt per second (a fraction of what is there), the heat and smoke a unit of fuel gives. */
  burn: number;
  heat: number;
  smoke: number;
  /** Gauss-Seidel iterations of the projection. */
  iterations: number;
}

export const NO_FORCES: GasForces = {
  buoyancy: 0, weight: 0, vorticity: 0, windX: 0, windY: 0, dissipation: 0, cooling: 0, burn: 0, heat: 0, smoke: 0, iterations: 30,
};

/** Over-relaxation of the Gauss-Seidel projection. */
const OMEGA = 1.9;

/**
 * A gas on a W x H MAC grid: face velocities u ((W+1) x H) and v (W x (H+1)), cell-centred density d,
 * temperature t and fuel f. Each side of the box is a wall (no flow through it) or open (outflow; what comes in
 * is clean air).
 */
export class GasSim {
  readonly u: Float32Array; readonly v: Float32Array;
  readonly d: Float32Array; readonly t: Float32Array; readonly f: Float32Array;
  private readonly u0: Float32Array; private readonly v0: Float32Array; private readonly tmp: Float32Array;
  private readonly curl: Float32Array; private readonly fx: Float32Array; private readonly fy: Float32Array;
  private readonly open: { l: boolean; r: boolean; t: boolean; b: boolean };

  constructor(readonly W: number, readonly H: number, readonly sides: Sides = WALLS) {
    const n = W * H;
    this.u = new Float32Array((W + 1) * H); this.v = new Float32Array(W * (H + 1));
    this.u0 = new Float32Array((W + 1) * H); this.v0 = new Float32Array(W * (H + 1));
    this.d = new Float32Array(n); this.t = new Float32Array(n); this.f = new Float32Array(n);
    this.tmp = new Float32Array(n); this.curl = new Float32Array(n); this.fx = new Float32Array(n); this.fy = new Float32Array(n);
    this.open = { l: sides.left === "open", r: sides.right === "open", t: sides.top === "open", b: sides.bottom === "open" };
  }

  /** Total density (the smoke's mass). */
  mass(): number {
    let s = 0;
    for (let i = 0; i < this.d.length; i++) s += this.d[i];
    return s;
  }

  /** The largest and mean absolute divergence over the cells (flux out of each cell, per cell). */
  divergence(): { max: number; mean: number } {
    const { W, H, u, v } = this;
    let max = 0, sum = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const dv = Math.abs(u[j * (W + 1) + i + 1] - u[j * (W + 1) + i] + v[(j + 1) * W + i] - v[j * W + i]);
      sum += dv;
      if (dv > max) max = dv;
    }
    return { max, mean: sum / (W * H) };
  }

  /** Walls let nothing through: their boundary faces are zero. */
  private walls(): void {
    const { W, H, u, v, open } = this;
    for (let j = 0; j < H; j++) {
      if (!open.l) u[j * (W + 1)] = 0;
      if (!open.r) u[j * (W + 1) + W] = 0;
    }
    for (let i = 0; i < W; i++) {
      if (!open.t) v[i] = 0;
      if (!open.b) v[H * W + i] = 0;
    }
  }

  /**
   * Makes the velocity divergence-free: Gauss-Seidel sweeps that spread each cell's divergence over the faces
   * that can move (a wall's cannot; an open side's can, as if the pressure outside were zero).
   */
  project(iterations: number): void {
    const { W, H, u, v, open } = this;
    const U = W + 1;
    this.walls();
    for (let it = 0; it < iterations; it++) {
      for (let j = 0; j < H; j++) {
        const st = j > 0 || open.t ? 1 : 0, sb = j < H - 1 || open.b ? 1 : 0;
        for (let i = 0; i < W; i++) {
          const sl = i > 0 || open.l ? 1 : 0, sr = i < W - 1 || open.r ? 1 : 0;
          const s = sl + sr + st + sb;
          if (!s) continue;
          const a = j * U + i, b = j * W + i;
          const div = u[a + 1] - u[a] + v[b + W] - v[b];
          const p = (-div / s) * OMEGA;
          u[a] -= sl * p; u[a + 1] += sr * p; v[b] -= st * p; v[b + W] += sb * p;
        }
      }
    }
  }

  /** A cell-centred field at (x, y) in cell coordinates (cell i's centre is i + 0.5); clean air past an open side. */
  private sampleC(q: Float32Array, x: number, y: number): number {
    const { W, H, open } = this;
    const fx = x - 0.5, fy = y - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), sx = fx - i0, sy = fy - j0;
    const at = (i: number, j: number) => {
      if (i < 0) { if (open.l) return 0; i = 0; } else if (i >= W) { if (open.r) return 0; i = W - 1; }
      if (j < 0) { if (open.t) return 0; j = 0; } else if (j >= H) { if (open.b) return 0; j = H - 1; }
      return q[j * W + i];
    };
    return (1 - sx) * ((1 - sy) * at(i0, j0) + sy * at(i0, j0 + 1)) + sx * ((1 - sy) * at(i0 + 1, j0) + sy * at(i0 + 1, j0 + 1));
  }

  private sampleU(q: Float32Array, x: number, y: number): number {
    const { W, H } = this;
    const fx = Math.min(W, Math.max(0, x)), fy = Math.min(H - 1, Math.max(0, y - 0.5));
    const i0 = Math.min(W - 1, Math.floor(fx)), j0 = Math.min(H - 2, Math.floor(fy)), sx = fx - i0, sy = fy - j0;
    const U = W + 1, k = j0 * U + i0;
    return (1 - sx) * ((1 - sy) * q[k] + sy * q[k + U]) + sx * ((1 - sy) * q[k + 1] + sy * q[k + U + 1]);
  }

  private sampleV(q: Float32Array, x: number, y: number): number {
    const { W, H } = this;
    const fx = Math.min(W - 1, Math.max(0, x - 0.5)), fy = Math.min(H, Math.max(0, y));
    const i0 = Math.min(W - 2, Math.floor(fx)), j0 = Math.min(H - 1, Math.floor(fy)), sx = fx - i0, sy = fy - j0;
    const k = j0 * W + i0;
    return (1 - sx) * ((1 - sy) * q[k] + sy * q[k + W]) + sx * ((1 - sy) * q[k + 1] + sy * q[k + W + 1]);
  }

  /** Semi-Lagrangian advection of a cell field: each cell takes the value from where its flow came from. */
  advectScalar(q: Float32Array, dt: number, wx: number, wy: number): void {
    const { W, H, u, v, tmp } = this;
    const U = W + 1;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const uc = 0.5 * (u[j * U + i] + u[j * U + i + 1]) + wx, vc = 0.5 * (v[j * W + i] + v[(j + 1) * W + i]) + wy;
      tmp[j * W + i] = this.sampleC(q, i + 0.5 - dt * uc, j + 0.5 - dt * vc);
    }
    q.set(tmp);
  }

  /** Semi-Lagrangian self-advection of the velocity (each face back along the flow). */
  advectVelocity(dt: number, wx: number, wy: number): void {
    const { W, H, u, v, u0, v0, open } = this;
    const U = W + 1;
    u0.set(u); v0.set(v);
    for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
      if ((i === 0 && !open.l) || (i === W && !open.r)) continue;
      const il = Math.max(0, i - 1), ir = Math.min(W - 1, i);
      const vv = 0.25 * (v0[j * W + il] + v0[j * W + ir] + v0[(j + 1) * W + il] + v0[(j + 1) * W + ir]) + wy;
      u[j * U + i] = this.sampleU(u0, i - dt * (u0[j * U + i] + wx), j + 0.5 - dt * vv);
    }
    for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
      if ((j === 0 && !open.t) || (j === H && !open.b)) continue;
      const jt = Math.max(0, j - 1), jb = Math.min(H - 1, j);
      const uu = 0.25 * (u0[jt * U + i] + u0[jt * U + i + 1] + u0[jb * U + i] + u0[jb * U + i + 1]) + wx;
      v[j * W + i] = this.sampleV(v0, i + 0.5 - dt * uu, j - dt * (v0[j * W + i] + wy));
    }
  }

  /** Buoyancy (hot gas rises, y is down) and weight (dense gas sinks), on the inner v faces. */
  private buoyancy(dt: number, k: GasForces): void {
    if (!k.buoyancy && !k.weight) return;
    const { W, H, v, d, t } = this;
    for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
      const a = (j - 1) * W + i, b = j * W + i;
      v[j * W + i] += dt * (k.weight * 0.5 * (d[a] + d[b]) - k.buoyancy * 0.5 * (t[a] + t[b]));
    }
  }

  /**
   * Vorticity confinement (Fedkiw, Stam & Jensen 2001): the curl w at cell centres, N the unit gradient of |w|,
   * and the force eps * (N x w) pushes small swirls back up that the coarse grid and advection smear away.
   */
  private confine(dt: number, eps: number): void {
    if (!eps) return;
    const { W, H, u, v, curl, fx, fy } = this;
    const U = W + 1;
    const uc = (i: number, j: number) => 0.5 * (u[j * U + i] + u[j * U + i + 1]);
    const vc = (i: number, j: number) => 0.5 * (v[j * W + i] + v[(j + 1) * W + i]);
    curl.fill(0); fx.fill(0); fy.fill(0);
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      curl[j * W + i] = 0.5 * (vc(i + 1, j) - vc(i - 1, j)) - 0.5 * (uc(i, j + 1) - uc(i, j - 1));
    }
    for (let j = 2; j < H - 2; j++) for (let i = 2; i < W - 2; i++) {
      const k = j * W + i;
      const nx = 0.5 * (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1])), ny = 0.5 * (Math.abs(curl[k + W]) - Math.abs(curl[k - W]));
      const len = Math.hypot(nx, ny) + 1e-6, w = curl[k];
      fx[k] = (eps * (ny / len) * w);
      fy[k] = (-eps * (nx / len) * w);
    }
    for (let j = 0; j < H; j++) for (let i = 1; i < W; i++) u[j * U + i] += dt * 0.5 * (fx[j * W + i - 1] + fx[j * W + i]);
    for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) v[j * W + i] += dt * 0.5 * (fy[(j - 1) * W + i] + fy[j * W + i]);
  }

  /** Burning (fuel -> heat and smoke), cooling and dissipation. */
  private react(dt: number, k: GasForces): void {
    const { d, t, f } = this;
    const cool = Math.exp(-k.cooling * dt), keep = Math.exp(-k.dissipation * dt), burnt = 1 - Math.exp(-k.burn * dt);
    for (let i = 0; i < d.length; i++) {
      if (k.burn && f[i] > 0) {
        const b = f[i] * burnt;
        f[i] -= b; t[i] += b * k.heat; d[i] += b * k.smoke;
      }
      t[i] *= cool; d[i] *= keep;
    }
  }

  /**
   * One fixed step: forces (buoyancy, vorticity confinement), the projection, advection of the fields by the
   * divergence-free velocity (plus wind), self-advection of the velocity, then burning, cooling and dissipation.
   * Sources are added before (emit).
   */
  step(dt: number, k: GasForces): void {
    this.buoyancy(dt, k);
    this.confine(dt, k.vorticity);
    this.project(k.iterations);
    this.advectScalar(this.d, dt, k.windX, k.windY);
    this.advectScalar(this.t, dt, k.windX, k.windY);
    if (k.burn) this.advectScalar(this.f, dt, k.windX, k.windY);
    this.advectVelocity(dt, k.windX, k.windY);
    this.react(dt, k);
  }

  /**
   * Adds sources: for each cell with weight w (0..1, times amount), density, temperature and fuel at the given
   * rates (a second's worth over dt), and the faces around it pulled toward the cell's velocity (vx, vy).
   */
  emit(weights: Float32Array, amount: Float32Array | number, dt: number, rate: { d: number; t: number; f: number },
    vel?: { x: Float32Array; y: Float32Array }): void {
    const { W, H, u, v, d, t, f } = this;
    const U = W + 1;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const w = weights[k];
      if (!w) continue;
      const a = w * (typeof amount === "number" ? amount : amount[k]);
      if (a <= 0) continue;
      d[k] += rate.d * a * dt; t[k] += rate.t * a * dt; f[k] += rate.f * a * dt;
      if (!vel) continue;
      const m = Math.min(1, a);
      const tx = vel.x[k], ty = vel.y[k];
      u[j * U + i] += (tx - u[j * U + i]) * m; u[j * U + i + 1] += (tx - u[j * U + i + 1]) * m;
      v[j * W + i] += (ty - v[j * W + i]) * m; v[(j + 1) * W + i] += (ty - v[(j + 1) * W + i]) * m;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Liquids: PIC/FLIP particles on a MAC grid.

const AIR = 0, FLUID = 1, SOLID = 2;

/**
 * A liquid as particles on a W x H MAC grid whose border cells are solid (a closed box). Each step: gravity and
 * motion, a push that keeps particles apart, the particles' velocities onto the grid, a projection with a density
 * correction (where particles bunch up, they are pushed apart, so volume is kept), and the grid's velocity back
 * onto the particles as a PIC/FLIP blend.
 */
export class FlipSim {
  readonly u: Float32Array; readonly v: Float32Array;
  private readonly pu: Float32Array; private readonly pv: Float32Array;
  private readonly wu: Float32Array; private readonly wv: Float32Array;
  readonly type: Uint8Array; readonly density: Float32Array;
  px: Float32Array; py: Float32Array; vx: Float32Array; vy: Float32Array;
  n = 0;
  /** Particles a full cell holds at rest (2 x 2) and their radius in cells. */
  readonly rest = 4;
  readonly radius = 0.25;
  /** Cells under this share of rest density count as air. */
  sparse = 0.25;
  private readonly cellStart: Int32Array; private readonly cellOrder: Int32Array;

  constructor(readonly W: number, readonly H: number, readonly max: number, readonly flip = 0.9) {
    this.u = new Float32Array((W + 1) * H); this.v = new Float32Array(W * (H + 1));
    this.pu = new Float32Array((W + 1) * H); this.pv = new Float32Array(W * (H + 1));
    this.wu = new Float32Array((W + 1) * H); this.wv = new Float32Array(W * (H + 1));
    this.type = new Uint8Array(W * H); this.density = new Float32Array(W * H);
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.cellStart = new Int32Array(W * H + 1); this.cellOrder = new Int32Array(max);
  }

  /** Adds a particle at (x, y) in cell coordinates with a velocity; false when full or inside a wall. */
  add(x: number, y: number, vx = 0, vy = 0): boolean {
    if (this.n >= this.max || x < 1 || y < 1 || x > this.W - 1 || y > this.H - 1) return false;
    const k = this.n++;
    this.px[k] = x; this.py[k] = y; this.vx[k] = vx; this.vy[k] = vy;
    return true;
  }

  /** The largest and mean absolute divergence over the fluid cells. */
  divergence(): { max: number; mean: number } {
    const { W, H, u, v, type } = this;
    let max = 0, sum = 0, n = 0;
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      if (type[j * W + i] !== FLUID) continue;
      const dv = Math.abs(u[j * (W + 1) + i + 1] - u[j * (W + 1) + i] + v[(j + 1) * W + i] - v[j * W + i]);
      sum += dv; n++;
      if (dv > max) max = dv;
    }
    return { max, mean: n ? sum / n : 0 };
  }

  private integrate(dt: number, g: number): void {
    const { px, py, vx, vy } = this;
    for (let k = 0; k < this.n; k++) {
      vy[k] += g * dt;
      px[k] += vx[k] * dt; py[k] += vy[k] * dt;
    }
  }

  /** Particles sorted by cell (counting sort), for neighbour lookups. */
  private sort(): void {
    const { W, H, px, py, cellStart, cellOrder } = this;
    cellStart.fill(0);
    const cell = (k: number) => Math.min(H - 1, Math.max(0, Math.floor(py[k]))) * W + Math.min(W - 1, Math.max(0, Math.floor(px[k])));
    for (let k = 0; k < this.n; k++) cellStart[cell(k) + 1]++;
    for (let c = 0; c < W * H; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, W * H);
    for (let k = 0; k < this.n; k++) cellOrder[fill[cell(k)]++] = k;
  }

  /** Pushes overlapping particles apart (each pair once, in index order). */
  private separate(iterations: number): void {
    const { W, H, px, py, cellStart, cellOrder } = this;
    const min = 2 * this.radius, min2 = min * min;
    for (let it = 0; it < iterations; it++) {
      this.sort();
      for (let k = 0; k < this.n; k++) {
        const ci = Math.floor(px[k]), cj = Math.floor(py[k]);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= W || j >= H) continue;
          const c = j * W + i;
          for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
            const q = cellOrder[s];
            if (q <= k) continue;
            const dx = px[q] - px[k], dy = py[q] - py[k], d2 = dx * dx + dy * dy;
            if (d2 >= min2 || d2 === 0) continue;
            const d = Math.sqrt(d2), push = (0.5 * (min - d)) / d;
            px[k] -= dx * push; py[k] -= dy * push; px[q] += dx * push; py[q] += dy * push;
          }
        }
      }
    }
  }

  /** Keeps particles out of the walls; the velocity into a wall stops. */
  private collide(): void {
    const { px, py, vx, vy } = this;
    const lo = 1 + this.radius, hiX = this.W - 1 - this.radius, hiY = this.H - 1 - this.radius;
    for (let k = 0; k < this.n; k++) {
      if (px[k] < lo) { px[k] = lo; if (vx[k] < 0) vx[k] = 0; }
      if (px[k] > hiX) { px[k] = hiX; if (vx[k] > 0) vx[k] = 0; }
      if (py[k] < lo) { py[k] = lo; if (vy[k] < 0) vy[k] = 0; }
      if (py[k] > hiY) { py[k] = hiY; if (vy[k] > 0) vy[k] = 0; }
    }
  }

  /** Particle velocities onto the faces (bilinear weights), cell types and the particle density per cell. */
  private toGrid(): void {
    const { W, H, u, v, wu, wv, type, density, px, py, vx, vy } = this;
    const U = W + 1;
    u.fill(0); v.fill(0); wu.fill(0); wv.fill(0); density.fill(0);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) type[j * W + i] = i === 0 || j === 0 || i === W - 1 || j === H - 1 ? SOLID : AIR;
    for (let k = 0; k < this.n; k++) {
      const c = Math.floor(py[k]) * W + Math.floor(px[k]);
      if (type[c] === AIR) type[c] = FLUID;
      // u faces sit at (i, j + 0.5).
      let x = px[k], y = py[k] - 0.5;
      let i0 = Math.min(W - 1, Math.floor(x)), j0 = Math.min(H - 2, Math.max(0, Math.floor(y)));
      let sx = x - i0, sy = Math.min(1, Math.max(0, y - j0));
      let a = j0 * U + i0;
      const w00 = (1 - sx) * (1 - sy), w10 = sx * (1 - sy), w01 = (1 - sx) * sy, w11 = sx * sy;
      u[a] += vx[k] * w00; wu[a] += w00; u[a + 1] += vx[k] * w10; wu[a + 1] += w10;
      u[a + U] += vx[k] * w01; wu[a + U] += w01; u[a + U + 1] += vx[k] * w11; wu[a + U + 1] += w11;
      // v faces sit at (i + 0.5, j).
      x = px[k] - 0.5; y = py[k];
      i0 = Math.min(W - 2, Math.max(0, Math.floor(x))); j0 = Math.min(H - 1, Math.floor(y));
      sx = Math.min(1, Math.max(0, x - i0)); sy = y - j0;
      a = j0 * W + i0;
      const v00 = (1 - sx) * (1 - sy), v10 = sx * (1 - sy), v01 = (1 - sx) * sy, v11 = sx * sy;
      v[a] += vy[k] * v00; wv[a] += v00; v[a + 1] += vy[k] * v10; wv[a + 1] += v10;
      v[a + W] += vy[k] * v01; wv[a + W] += v01; v[a + W + 1] += vy[k] * v11; wv[a + W + 1] += v11;
      // Density at cell centres.
      x = px[k] - 0.5; y = py[k] - 0.5;
      i0 = Math.max(0, Math.min(W - 2, Math.floor(x))); j0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
      sx = Math.min(1, Math.max(0, x - i0)); sy = Math.min(1, Math.max(0, y - j0));
      a = j0 * W + i0;
      density[a] += (1 - sx) * (1 - sy); density[a + 1] += sx * (1 - sy); density[a + W] += (1 - sx) * sy; density[a + W + 1] += sx * sy;
    }
    // A cell with a stray particle or two is spray, not water: kept as air, so pockets the liquid closes over
    // collapse instead of holding their shape as incompressible fluid.
    for (let c = 0; c < type.length; c++) if (type[c] === FLUID && density[c] < this.sparse * this.rest) type[c] = AIR;
    for (let k = 0; k < u.length; k++) if (wu[k] > 0) u[k] /= wu[k];
    for (let k = 0; k < v.length; k++) if (wv[k] > 0) v[k] /= wv[k];
    // Faces touching a wall do not move (the walls are still).
    for (let j = 0; j < H; j++) for (let i = 0; i <= W; i++) {
      if (i === 0 || i === W || type[j * W + i - 1] === SOLID || type[j * W + i] === SOLID) u[j * U + i] = 0;
    }
    for (let j = 0; j <= H; j++) for (let i = 0; i < W; i++) {
      if (j === 0 || j === H || type[(j - 1) * W + i] === SOLID || type[j * W + i] === SOLID) v[j * W + i] = 0;
    }
    this.pu.set(u); this.pv.set(v);
  }

  /** Gauss-Seidel projection over the fluid cells; air outside is at zero pressure, walls do not move. */
  project(iterations: number, drift = 1): void {
    const { W, H, u, v, type, density, rest } = this;
    const U = W + 1;
    const open = (c: number) => (type[c] === SOLID ? 0 : 1);
    for (let it = 0; it < iterations; it++) {
      for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
        const c = j * W + i;
        if (type[c] !== FLUID) continue;
        const sl = open(c - 1), sr = open(c + 1), st = open(c - W), sb = open(c + W), s = sl + sr + st + sb;
        if (!s) continue;
        const a = j * U + i;
        let div = u[a + 1] - u[a] + v[c + W] - v[c];
        if (drift && density[c] > rest) div -= drift * (density[c] - rest);
        const p = (-div / s) * OMEGA;
        u[a] -= sl * p; u[a + 1] += sr * p; v[c] -= st * p; v[c + W] += sb * p;
      }
    }
  }

  /** Grid velocity back onto the particles: PIC (the grid's) blended with FLIP (the particle's plus the change). */
  private toParticles(): void {
    const { W, H, u, v, pu, pv, type, px, py, vx, vy, flip } = this;
    const U = W + 1;
    const near = (c: number) => type[c] !== AIR;
    for (let k = 0; k < this.n; k++) {
      // u at (x, y - 0.5); a face counts when a cell beside it is not air.
      let x = px[k], y = py[k] - 0.5;
      let i0 = Math.min(W - 1, Math.floor(x)), j0 = Math.min(H - 2, Math.max(0, Math.floor(y)));
      let sx = x - i0, sy = Math.min(1, Math.max(0, y - j0));
      let ws = 0, pic = 0, dlt = 0;
      for (const [di, dj, w] of [[0, 0, (1 - sx) * (1 - sy)], [1, 0, sx * (1 - sy)], [0, 1, (1 - sx) * sy], [1, 1, sx * sy]] as const) {
        const i = i0 + di, j = j0 + dj, a = j * U + i;
        const valid = (i > 0 && near(j * W + i - 1)) || (i < W && near(j * W + i));
        if (!valid || !w) continue;
        ws += w; pic += w * u[a]; dlt += w * (u[a] - pu[a]);
      }
      if (ws > 0) vx[k] = (1 - flip) * (pic / ws) + flip * (vx[k] + dlt / ws);
      // v at (x - 0.5, y).
      x = px[k] - 0.5; y = py[k];
      i0 = Math.min(W - 2, Math.max(0, Math.floor(x))); j0 = Math.min(H - 1, Math.floor(y));
      sx = Math.min(1, Math.max(0, x - i0)); sy = y - j0;
      ws = 0; pic = 0; dlt = 0;
      for (const [di, dj, w] of [[0, 0, (1 - sx) * (1 - sy)], [1, 0, sx * (1 - sy)], [0, 1, (1 - sx) * sy], [1, 1, sx * sy]] as const) {
        const i = i0 + di, j = j0 + dj, a = j * W + i;
        const valid = (j > 0 && near((j - 1) * W + i)) || (j < H && near(j * W + i));
        if (!valid || !w) continue;
        ws += w; pic += w * v[a]; dlt += w * (v[a] - pv[a]);
      }
      if (ws > 0) vy[k] = (1 - flip) * (pic / ws) + flip * (vy[k] + dlt / ws);
    }
  }

  /** One fixed step with gravity g (cells/s², down). */
  step(dt: number, g: number, iterations = 40): void {
    this.integrate(dt, g);
    this.separate(2);
    this.collide();
    this.toGrid();
    this.project(iterations);
    this.toParticles();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Presets, emitters and rendering.

export type FluidKind = "gas" | "liquid";
export type FluidPresetName = "smoke-puff" | "smoke" | "torch" | "fire-burst" | "poison-gas" | "steam" | "splash" | "pour";
export type EmitterShape = "point" | "disc" | "line" | "rect";

/** Where the fluid comes from, in canvas pixels. */
export interface Emitter {
  shape: EmitterShape;
  x: number; y: number;
  /** line: the other end. */
  x2?: number; y2?: number;
  /** rect: size from x, y (its top-left). */
  w?: number; h?: number;
  /** disc radius, line half-thickness. */
  r?: number;
  /** Velocity at the source (px/s; y down), and an outward speed from its centre (px/s). */
  vx?: number; vy?: number; radial?: number;
}

export interface FluidPreset {
  kind: FluidKind;
  what: string;
  width: number; height: number;
  fps: number; durationMs: number; loop: boolean;
  /** Default colors, dark to bright. */
  ramp: string[];
  emitter: (w: number, h: number) => Emitter;
  /** Sides that are open (outflow); the rest are walls. Liquids are always in a closed box. */
  sides: Sides;
  /** The emitter is on while t (s) < this (Infinity: always). */
  emitFor: number;
  /** Per-second source rates of density, temperature and fuel. */
  rate: { d: number; t: number; f: number };
  /** Random flicker of the source per cell and step (0: steady). */
  jitter: number;
  buoyancy: number; weight: number; vorticity: number; wind: { x: number; y: number };
  dissipation: number; cooling: number; burn: number; heat: number; smoke: number;
  /** The field shown: density or temperature; value = 1 - exp(-gain * field). */
  show: "density" | "temperature";
  gain: number;
  /** Liquids: gravity (px/s²), the starting pool depth (0..1 of the height) and particles spawned a second at the emitter (0: the emitter is the starting liquid). */
  gravity?: number; level?: number; spawn?: number;
}

const GRAYS = ["#2e2c38", "#4a4856", "#6c6a78", "#908e9a", "#b8b6c0", "#dedce4"];
const FIRE = ["#4a0d12", "#8c1a14", "#cc3a12", "#ee7417", "#fbb22e", "#ffe27a", "#fffbe0"];
const POISON = ["#1d3320", "#2c5a2a", "#3f8a33", "#6cb83f", "#a8e05a", "#e0f79a"];
const STEAM = ["#7d8d9c", "#a0aebb", "#c2ccd6", "#dde4ea", "#f4f7fa"];
const WATER = ["#14305e", "#1f4f97", "#2f78c8", "#55a6e6", "#9ad4f7", "#e8f8ff"];
const SKY: Sides = { left: "open", right: "open", top: "open", bottom: "wall" };
const OPEN: Sides = { left: "open", right: "open", top: "open", bottom: "open" };
const BASE = { weight: 0, wind: { x: 0, y: 0 }, burn: 0, heat: 0, smoke: 0, jitter: 0, cooling: 0 };

export const FLUID_PRESETS: Record<FluidPresetName, FluidPreset> = {
  "smoke-puff": {
    ...BASE, kind: "gas", what: "a puff of smoke that billows up and fades (one-shot)",
    width: 40, height: 40, fps: 12, durationMs: 1500, loop: false, ramp: GRAYS, sides: OPEN,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h * 0.68, r: Math.max(2, w / 9), vy: -18, radial: 26 }),
    emitFor: 0.18, rate: { d: 16, t: 8, f: 0 }, jitter: 0.5,
    buoyancy: 14, vorticity: 9, dissipation: 0.9, cooling: 1.2, show: "density", gain: 1.4,
  },
  smoke: {
    ...BASE, kind: "gas", what: "a rising column of smoke, like a chimney or a smouldering fire (loop)",
    width: 32, height: 64, fps: 12, durationMs: 2000, loop: true, ramp: GRAYS, sides: SKY,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h - 4, r: Math.max(1.5, w / 12), vy: -26 }),
    emitFor: Infinity, rate: { d: 5, t: 4, f: 0 }, jitter: 0.6, wind: { x: 3, y: 0 },
    buoyancy: 22, vorticity: 8, dissipation: 0.3, cooling: 0.4, show: "density", gain: 1.3,
  },
  torch: {
    ...BASE, kind: "gas", what: "a torch or campfire flame that licks upward (loop)",
    width: 24, height: 40, fps: 12, durationMs: 1000, loop: true, ramp: FIRE, sides: SKY,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h - 4, r: Math.max(2, w / 9), vy: -28 }),
    emitFor: Infinity, rate: { d: 0, t: 6, f: 10 }, jitter: 0.9,
    buoyancy: 34, vorticity: 7, dissipation: 0, cooling: 4.2, burn: 5, heat: 1, smoke: 0, show: "temperature", gain: 1.1,
  },
  "fire-burst": {
    ...BASE, kind: "gas", what: "a fireball burst that blooms out, rises and burns away (one-shot)",
    width: 48, height: 48, fps: 12, durationMs: 1200, loop: false, ramp: FIRE, sides: OPEN,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h * 0.6, r: Math.max(2, w / 10), radial: 70 }),
    emitFor: 0.12, rate: { d: 0, t: 30, f: 40 }, jitter: 0.6,
    buoyancy: 18, vorticity: 12, dissipation: 0, cooling: 2.6, burn: 6, heat: 1, smoke: 0, show: "temperature", gain: 0.9,
  },
  "poison-gas": {
    ...BASE, kind: "gas", what: "a low poison cloud that swirls and drifts along the ground (loop)",
    width: 64, height: 40, fps: 12, durationMs: 2400, loop: true, ramp: POISON, sides: SKY,
    emitter: (w, h) => ({ shape: "rect", x: Math.round(w * 0.12), y: h - 8, w: Math.round(w * 0.3), h: 5, vx: 6, vy: -3 }),
    emitFor: Infinity, rate: { d: 2.6, t: 1, f: 0 }, jitter: 0.7, wind: { x: 6, y: 0 },
    buoyancy: 5, weight: 2, vorticity: 16, dissipation: 0.3, cooling: 0.6, show: "density", gain: 1.2,
  },
  steam: {
    ...BASE, kind: "gas", what: "a thin wisp of steam rising and vanishing, over a cup or a vent (loop)",
    width: 24, height: 48, fps: 12, durationMs: 1600, loop: true, ramp: STEAM, sides: SKY,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h - 3, r: 2, vy: -26 }),
    emitFor: Infinity, rate: { d: 9, t: 5, f: 0 }, jitter: 0.5, wind: { x: 2, y: 0 },
    buoyancy: 16, vorticity: 6, dissipation: 1.2, cooling: 0.8, show: "density", gain: 1.6,
  },
  splash: {
    ...BASE, kind: "liquid", what: "a blob of water falling into a shallow pool and splashing (one-shot)",
    width: 48, height: 32, fps: 12, durationMs: 1500, loop: false, ramp: WATER, sides: WALLS,
    emitter: (w, h) => ({ shape: "disc", x: w / 2, y: h * 0.28, r: Math.max(2, Math.min(w, h) / 6) }),
    emitFor: 0, rate: { d: 0, t: 0, f: 0 }, buoyancy: 0, vorticity: 0, dissipation: 0, show: "density", gain: 1,
    gravity: 320, level: 0.28, spawn: 0,
  },
  pour: {
    ...BASE, kind: "liquid", what: "a stream of water pouring from the side and filling the bottom (one-shot)",
    width: 40, height: 40, fps: 12, durationMs: 3000, loop: false, ramp: WATER, sides: WALLS,
    emitter: (w, h) => ({ shape: "rect", x: 2, y: Math.round(h * 0.15), w: 3, h: 3, vx: 26, vy: 0 }),
    emitFor: 1.2, rate: { d: 0, t: 0, f: 0 }, buoyancy: 0, vorticity: 0, dissipation: 0, show: "density", gain: 1,
    gravity: 320, level: 0, spawn: 260,
  },
};
export const FLUID_PRESET_NAMES = Object.keys(FLUID_PRESETS) as FluidPresetName[];

/** Everything a render needs; anything left out comes from the preset. */
export interface FluidSettings {
  preset: FluidPresetName;
  width?: number; height?: number;
  frames?: number; fps?: number;
  loop?: boolean;
  seed?: number;
  /** Colors, dark to bright (at least 2). */
  ramp?: RGBA[];
  /** Strength knobs over the preset's (px and seconds). */
  buoyancy?: number; vorticity?: number; wind?: { x: number; y: number }; dissipation?: number; gravity?: number;
  /** Source strength multiplier (1 = the preset's). */
  strength?: number;
  emitter?: Emitter;
  /** An emitter mask (alpha 0..255 per canvas pixel) instead of the emitter shape, e.g. a layer's pixels. */
  mask?: Uint8Array;
  /** Grid cells per pixel: 1 or 2. Default 2 for small gases (up to 48 px a side), else 1. */
  resolution?: 1 | 2;
  /** Values below this are transparent (0..1). Default 0.06. */
  threshold?: number;
  /** Liquids: starting pool depth (0..1). */
  level?: number;
}

export interface FluidRender {
  frames: Rgba[];
  width: number; height: number; fps: number; loop: boolean; durationMs: number;
  /** The emitter's centre in canvas pixels (the FX record's origin). */
  origin: { x: number; y: number };
  grid: { width: number; height: number; resolution: number };
  steps: number;
  ms: number;
  /** For loops: pixels that change from the last frame to the first, and the median change between neighbours. */
  seam?: { last: number; median: number };
  /** The colors the frames use, dark to bright. */
  colors: string[];
}

/** Gas steps a second (fixed). */
export const GAS_HZ = 40;
/** Liquid steps a second (fixed; smaller, since the fall is fast). */
export const LIQUID_HZ = 120;
export const MAX_SIZE = 128;

/** The emitter as per-pixel weights (0..1) over a W x H canvas. */
export function emitterMask(e: Emitter, W: number, H: number): Float32Array {
  const m = new Float32Array(W * H);
  const r = e.r ?? (e.shape === "point" ? 1 : e.shape === "line" ? 0.75 : 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    let inside = false;
    if (e.shape === "rect") {
      inside = cx >= e.x && cx < e.x + (e.w ?? 1) && cy >= e.y && cy < e.y + (e.h ?? 1);
    } else if (e.shape === "line") {
      const x2 = e.x2 ?? e.x, y2 = e.y2 ?? e.y, dx = x2 - e.x, dy = y2 - e.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((cx - e.x) * dx + (cy - e.y) * dy) / l2)) : 0;
      inside = Math.hypot(cx - (e.x + t * dx), cy - (e.y + t * dy)) <= r;
    } else {
      inside = Math.hypot(cx - e.x, cy - e.y) <= r;
    }
    if (inside) m[y * W + x] = 1;
  }
  // A point smaller than a pixel still emits from the pixel it is in.
  if (!m.some((v) => v > 0)) {
    const x = Math.min(W - 1, Math.max(0, Math.floor(e.x))), y = Math.min(H - 1, Math.max(0, Math.floor(e.y)));
    m[y * W + x] = 1;
  }
  return m;
}

/** The weighted centre of a mask, rounded to a pixel. */
function centroid(m: Float32Array, W: number): { x: number; y: number } {
  let sx = 0, sy = 0, s = 0;
  for (let k = 0; k < m.length; k++) if (m[k]) { sx += m[k] * ((k % W) + 0.5); sy += m[k] * (Math.floor(k / W) + 0.5); s += m[k]; }
  return s ? { x: Math.floor(sx / s), y: Math.floor(sy / s) } : { x: 0, y: 0 };
}

/** Parses "#rrggbb" for the default ramps. */
function rgb(h: string): RGBA {
  return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: 255 };
}
const hex6 = (c: RGBA) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * A scalar (0..1 per pixel) as palette pixels: `levels` steps of the ramp with ordered (Bayer 4x4) dithering
 * between neighbouring steps, and fully transparent below the threshold. With `clear`, transparency is the step
 * under the ramp's first color, so edges dither into nothing; without, every pixel at or over the threshold gets a
 * color. No alpha blending: each pixel is a ramp color or transparent.
 */
export function shade(value: Float32Array, W: number, H: number, ramp: RGBA[], threshold: number, clear: boolean): Rgba {
  const data = new Uint8Array(W * H * 4), N = ramp.length;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = value[y * W + x];
    if (!(v >= threshold) || v <= 0) continue;
    const b = BAYER4[y & 3][x & 3];
    let idx: number;
    if (clear) {
      idx = Math.min(N, Math.floor(Math.min(1, v) * N + b)) - 1;
      if (idx < 0) continue;
    } else {
      idx = Math.min(N - 1, Math.floor(Math.min(1, v) * (N - 1) + b));
    }
    const c = ramp[idx], o = (y * W + x) * 4;
    data[o] = c.r; data[o + 1] = c.g; data[o + 2] = c.b; data[o + 3] = 255;
  }
  return { width: W, height: H, data };
}

/** Pixels that differ between two frames. */
export function frameDiff(a: Rgba, b: Rgba): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n++;
  }
  return n;
}

/** A loop's seam: the change from its last frame to its first, against the median change between neighbours. */
export function loopSeam(frames: Rgba[]): { last: number; median: number } {
  const steps = frames.slice(1).map((f, i) => frameDiff(frames[i], f)).sort((a, b) => a - b);
  return { last: frameDiff(frames[frames.length - 1], frames[0]), median: steps.length ? steps[Math.floor(steps.length / 2)] : 0 };
}

/** The resolved settings of a render, preset defaults filled in (what the FX record stores). */
export function resolveSettings(s: FluidSettings) {
  const p = FLUID_PRESETS[s.preset];
  if (!p) throw new Error(`No fluid preset '${s.preset}'. Presets: ${FLUID_PRESET_NAMES.join(", ")}.`);
  const width = Math.round(s.width ?? p.width), height = Math.round(s.height ?? p.height);
  if (width < 8 || height < 8 || width > MAX_SIZE || height > MAX_SIZE) throw new Error(`The fluid's size must be 8..${MAX_SIZE} a side (got ${width}x${height}).`);
  const fps = s.fps ?? p.fps;
  const frames = s.frames ?? Math.max(2, Math.round((p.durationMs * fps) / 1000));
  const resolution = s.resolution ?? (p.kind === "gas" && Math.max(width, height) <= 48 ? 2 : 1);
  return {
    p, width, height, fps, frames, resolution,
    loop: s.loop ?? p.loop,
    seed: s.seed ?? 1,
    ramp: s.ramp && s.ramp.length >= 2 ? s.ramp : p.ramp.map(rgb),
    buoyancy: s.buoyancy ?? p.buoyancy,
    vorticity: s.vorticity ?? p.vorticity,
    wind: s.wind ?? p.wind,
    dissipation: s.dissipation ?? p.dissipation,
    gravity: s.gravity ?? p.gravity ?? 0,
    strength: s.strength ?? 1,
    emitter: s.emitter ?? p.emitter(width, height),
    threshold: s.threshold ?? 0.06,
    level: s.level ?? p.level ?? 0,
  };
}

/** Renders a fluid preset to palette frames. Deterministic for the same settings. */
export function renderFluid(s: FluidSettings): FluidRender {
  const started = performance.now();
  const r = resolveSettings(s);
  const { width: W, height: H } = r;
  const weights = s.mask ? Float32Array.from(s.mask, (a) => a / 255) : emitterMask(r.emitter, W, H);
  if (!weights.some((v) => v > 0)) throw new Error("The emitter covers no pixel of the canvas.");
  const origin = centroid(weights, W);
  const fields = r.p.kind === "gas" ? gasFields(r, weights) : liquidFields(r, weights);
  let { raw, aux } = fields;
  const out = r.frames;
  // Seamless loop: simulate 2L frames and crossfade the fields (not the colors) of L..2L into 0..L, so the last frame
  // flows straight into the first; one-shots fade out over their last quarter so they end empty.
  if (r.loop) {
    const mix = (a: Float32Array[]) => Array.from({ length: out }, (_, k) => {
      const w = k / out, x = a[k], y = a[k + out], m = new Float32Array(x.length);
      for (let i = 0; i < m.length; i++) m[i] = (1 - w) * y[i] + w * x[i];
      return m;
    });
    raw = mix(raw);
    if (aux) aux = mix(aux);
  } else if (r.p.kind === "gas") {
    const fadeFrom = Math.floor(out * 0.7);
    raw = raw.map((f, k) => {
      if (k < fadeFrom) return f;
      const t = (k - fadeFrom + 1) / (out - fadeFrom), g = 1 - t * t * (3 - 2 * t);
      return f.map((v) => v * g);
    });
  }
  const frames = r.p.kind === "gas"
    ? raw.map((f) => shade(f.map((v) => 1 - Math.exp(-r.p.gain * v)), W, H, r.ramp, r.threshold, true))
    : raw.map((f, k) => shadeLiquid(f, aux![k], W, H, r.ramp));
  const used = new Set<string>();
  for (const f of frames) for (let i = 0; i < f.data.length; i += 4) if (f.data[i + 3]) used.add(hex6({ r: f.data[i], g: f.data[i + 1], b: f.data[i + 2], a: 255 }));
  const colors = r.ramp.map(hex6).filter((h, i, all) => used.has(h) && all.indexOf(h) === i);
  return {
    frames, width: W, height: H, fps: r.fps, loop: r.loop, durationMs: Math.round((out * 1000) / r.fps), origin,
    grid: { width: W * r.resolution, height: H * r.resolution, resolution: r.resolution }, steps: fields.steps,
    ms: Math.round(performance.now() - started), seam: r.loop ? loopSeam(frames) : undefined, colors,
  };
}

type Resolved = ReturnType<typeof resolveSettings>;

/** The step count at the end of frame k (frame k shows the state at (k + 1) / fps s after a warm-up). */
const stepsAt = (k: number, fps: number, hz: number) => Math.round(((k + 1) * hz) / fps);

/** Nearest-neighbour upsample of a canvas mask to the grid. */
function toGrid(m: Float32Array, W: number, H: number, s: number): Float32Array {
  if (s === 1) return m;
  const g = new Float32Array(W * s * H * s);
  for (let j = 0; j < H * s; j++) for (let i = 0; i < W * s; i++) g[j * W * s + i] = m[Math.floor(j / s) * W + Math.floor(i / s)];
  return g;
}

/** Block average of a grid field down to the canvas. */
function toCanvas(q: Float32Array, W: number, H: number, s: number): Float32Array {
  if (s === 1) return Float32Array.from(q);
  const out = new Float32Array(W * H), GW = W * s, n = s * s;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) sum += q[(y * s + j) * GW + x * s + i];
    out[y * W + x] = sum / n;
  }
  return out;
}

/** Runs the gas sim; one canvas-sized field per output frame (2L for loops, after a warm-up). */
function gasFields(r: Resolved, mask: Float32Array): { raw: Float32Array[]; aux?: Float32Array[]; steps: number } {
  const { p, width: W, height: H, resolution: s, fps } = r;
  const GW = W * s, GH = H * s;
  const sim = new GasSim(GW, GH, p.sides);
  const k: GasForces = {
    buoyancy: r.buoyancy * s, weight: p.weight * s, vorticity: r.vorticity * s, windX: r.wind.x * s, windY: r.wind.y * s,
    dissipation: r.dissipation, cooling: p.cooling, burn: p.burn, heat: p.heat, smoke: p.smoke, iterations: 30,
  };
  const weights = toGrid(mask, W, H, s);
  // Source velocity per cell: the emitter's own plus an outward push from its centre.
  const e = r.emitter, c = centroid(mask, W);
  const velX = new Float32Array(GW * GH), velY = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const q = j * GW + i;
    if (!weights[q]) continue;
    const dx = (i + 0.5) / s - (c.x + 0.5), dy = (j + 0.5) / s - (c.y + 0.5), d = Math.hypot(dx, dy) || 1;
    velX[q] = ((e.vx ?? 0) + ((e.radial ?? 0) * dx) / d) * s;
    velY[q] = ((e.vy ?? 0) + ((e.radial ?? 0) * dy) / d) * s;
  }
  const rate = { d: p.rate.d * r.strength, t: p.rate.t * r.strength, f: p.rate.f * r.strength };
  const random = rng(r.seed);
  const amount = new Float32Array(GW * GH);
  const dt = 1 / GAS_HZ;
  const total = r.loop ? 2 * r.frames : r.frames;
  // Loops start from a running source (one cycle of warm-up), so the first frames are not the fill-up.
  const warm = r.loop ? Math.round(GAS_HZ * Math.max(1, (r.frames / fps) * 0.75)) : 0;
  const raw: Float32Array[] = [];
  let n = 0;
  const run = (until: number) => {
    for (; n < until; n++) {
      const t = n * dt;
      if (t < p.emitFor) {
        for (let q = 0; q < amount.length; q++) amount[q] = weights[q] ? 1 + p.jitter * (2 * random() - 1) : 0;
        sim.emit(weights, amount, dt, rate, { x: velX, y: velY });
      }
      sim.step(dt, k);
    }
  };
  run(warm);
  for (let f = 0; f < total; f++) {
    run(warm + stepsAt(f, fps, GAS_HZ));
    raw.push(toCanvas(p.show === "temperature" ? sim.t : sim.d, W, H, s));
  }
  return { raw, steps: n };
}

/** Runs the liquid sim; per output frame the smoothed occupancy (1 = full) and the speed (px/s) per pixel. */
function liquidFields(r: Resolved, mask: Float32Array): { raw: Float32Array[]; aux: Float32Array[]; steps: number } {
  const { p, width: W, height: H, resolution: s, fps } = r;
  const GW = W * s + 2, GH = H * s + 2; // a wall cell around the canvas
  const sim = new FlipSim(GW, GH, Math.ceil(GW * GH * 4 * 0.9));
  const random = rng(r.seed);
  const e = r.emitter;
  const place = (x0: number, y0: number, vx: number, vy: number) => {
    // 2 x 2 jittered particles in a cell.
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      sim.add(x0 + ox + (random() - 0.5) * 0.2, y0 + oy + (random() - 0.5) * 0.2, vx, vy);
    }
  };
  // The starting pool, then the emitter's liquid (unless it spawns over time).
  const poolTop = GH - 1 - Math.round(r.level * H * s);
  for (let j = poolTop; j < GH - 1; j++) for (let i = 1; i < GW - 1; i++) place(i, j, 0, 0);
  const cells = toGrid(mask, W, H, s);
  const spawn = (p.spawn ?? 0) * r.strength;
  if (!spawn) {
    for (let j = 0; j < H * s; j++) for (let i = 0; i < W * s; i++) {
      if (cells[j * W * s + i] > 0.5 && j + 1 < poolTop) place(i + 1, j + 1, (e.vx ?? 0) * s, (e.vy ?? 0) * s);
    }
  }
  const sources: number[] = [];
  for (let q = 0; q < cells.length; q++) if (cells[q] > 0.5) sources.push(q);
  const dt = 1 / LIQUID_HZ, g = r.gravity * s;
  const total = r.loop ? 2 * r.frames : r.frames;
  const raw: Float32Array[] = [], aux: Float32Array[] = [];
  let n = 0, owed = 0;
  for (let f = 0; f < total; f++) {
    for (const until = stepsAt(f, fps, LIQUID_HZ); n < until; n++) {
      if (spawn && n * dt < p.emitFor) {
        // Particles at the source, a second's `spawn` cells' worth, spread over the steps.
        owed += (spawn * dt) / Math.max(1, sources.length / (s * s));
        for (; owed >= 1; owed--) for (const q of sources) place((q % (W * s)) + 1, Math.floor(q / (W * s)) + 1, (e.vx ?? 0) * s, (e.vy ?? 0) * s);
      }
      sim.step(dt, g);
    }
    const { occupancy, speed } = rasterize(sim, W, H, s);
    raw.push(occupancy); aux.push(speed);
  }
  return { raw, aux, steps: n };
}

/** Particles onto canvas pixels: occupancy (1 = a pixel full at rest), smoothed by a 3x3 tent, and the mean speed. */
function rasterize(sim: FlipSim, W: number, H: number, s: number): { occupancy: Float32Array; speed: Float32Array } {
  const count = new Float32Array(W * H), sp = new Float32Array(W * H);
  const full = sim.rest * s * s;
  for (let k = 0; k < sim.n; k++) {
    const x = (sim.px[k] - 1) / s - 0.5, y = (sim.py[k] - 1) / s - 0.5;
    const i0 = Math.floor(x), j0 = Math.floor(y), fx = x - i0, fy = y - j0;
    const v = Math.hypot(sim.vx[k], sim.vy[k]) / s;
    for (const [di, dj, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
      const i = Math.min(W - 1, Math.max(0, i0 + di)), j = Math.min(H - 1, Math.max(0, j0 + dj));
      count[j * W + i] += w; sp[j * W + i] += w * v;
    }
  }
  const occupancy = new Float32Array(W * H), speed = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0, ws = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const w = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
      sum += w * count[yy * W + xx]; ws += w;
    }
    occupancy[y * W + x] = sum / ws / full;
    speed[y * W + x] = count[y * W + x] > 0 ? sp[y * W + x] / count[y * W + x] : 0;
  }
  return { occupancy, speed };
}

/** Liquid pixels: inside where occupancy passes half; lit at the surface, darker with depth, foam where it is fast. */
export function shadeLiquid(occupancy: Float32Array, speed: Float32Array, W: number, H: number, ramp: RGBA[]): Rgba {
  const value = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    let depth = 0;
    for (let y = 0; y < H; y++) {
      const k = y * W + x;
      if (occupancy[k] < 0.4) { depth = 0; continue; }
      let v = depth === 0 ? 0.95 : depth === 1 ? 0.72 : depth === 2 ? 0.56 : Math.max(0.12, 0.46 - 0.025 * (depth - 3));
      if (speed[k] > 70) v = Math.max(v, 0.85);
      value[k] = Math.max(0.01, v);
      depth++;
    }
  }
  return shade(value, W, H, ramp, 0.005, false);
}
