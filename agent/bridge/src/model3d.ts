// 3D model to pixel sprites (#44): a small software renderer for tiny
// pixel-art output. Loads glTF/GLB (meshes, node hierarchy, base colors,
// vertex colors, node-transform animations) and OBJ (+ .mtl colors), and
// renders orthographic views with a z-buffer at the target size, toon
// bands and no anti-aliasing. Skinned meshes render in their bind pose.
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

type Vec3 = [number, number, number];
type Mat4 = number[]; // column-major 4x4

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: [number, number, number];
}

/** A model: a function from animation time to world-space triangles. */
export interface Model {
  clips: { name: string; duration: number }[];
  /** Triangles at time t (seconds) of clip (or the rest pose). */
  triangles(clip?: string, t?: number): Triangle[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function trs(t: Vec3 = [0, 0, 0], q: [number, number, number, number] = [0, 0, 0, 1], s: Vec3 = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
  return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0, r[3] * s[1], r[4] * s[1], r[5] * s[1], 0, r[6] * s[2], r[7] * s[2], r[8] * s[2], 0, t[0], t[1], t[2], 1];
}

const apply = (m: Mat4, v: Vec3): Vec3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

function slerp(a: number[], b: number[], t: number): number[] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (bb[i] - v) * t);
    const l = Math.hypot(...r);
    return r.map((v) => v / l);
  }
  const th = Math.acos(d), s = Math.sin(th);
  return a.map((v, i) => (Math.sin((1 - t) * th) * v + Math.sin(t * th) * bb[i]) / s);
}

// ---------------------------------------------------------------------------
// glTF / GLB
// ---------------------------------------------------------------------------

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGltf(path: string): { json: any; bin: Buffer[] } {
  const raw = readFileSync(path);
  if (raw.toString("ascii", 0, 4) === "glTF") {
    // GLB: header (12) then chunks: JSON, BIN.
    let p = 12, json: any, bin: Buffer | undefined;
    while (p < raw.length) {
      const len = raw.readUInt32LE(p), type = raw.readUInt32LE(p + 4);
      const data = raw.subarray(p + 8, p + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
      if (type === 0x004e4942) bin = data;
      p += 8 + len;
    }
    return { json, bin: (json.buffers ?? []).map((b: any) => (b.uri ? loadUri(b.uri, path) : bin!)) };
  }
  const json = JSON.parse(raw.toString("utf8"));
  return { json, bin: (json.buffers ?? []).map((b: any) => loadUri(b.uri, path)) };
}

function loadUri(uri: string, base: string): Buffer {
  const m = /^data:[^;]*;base64,(.*)$/.exec(uri);
  if (m) return Buffer.from(m[1], "base64");
  return readFileSync(join(dirname(base), decodeURIComponent(uri)));
}

function accessor(json: any, bins: Buffer[], i: number): number[][] {
  const a = json.accessors[i];
  const n = COMPONENTS[a.type];
  const out: number[][] = [];
  if (a.bufferView === undefined) {
    for (let k = 0; k < a.count; k++) out.push(new Array(n).fill(0));
    return out;
  }
  const bv = json.bufferViews[a.bufferView];
  const buf = bins[bv.buffer];
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as number]!;
  const stride = bv.byteStride ?? size * n;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const norm = (v: number, max: number) => (a.normalized ? v / max : v);
  for (let k = 0; k < a.count; k++) {
    const row: number[] = [];
    for (let c = 0; c < n; c++) {
      const o = base + k * stride + c * size;
      switch (a.componentType) {
        case 5126: row.push(buf.readFloatLE(o)); break;
        case 5125: row.push(buf.readUInt32LE(o)); break;
        case 5123: row.push(norm(buf.readUInt16LE(o), 65535)); break;
        case 5122: row.push(norm(buf.readInt16LE(o), 32767)); break;
        case 5121: row.push(norm(buf.readUInt8(o), 255)); break;
        default: row.push(norm(buf.readInt8(o), 127));
      }
    }
    out.push(row);
  }
  return out;
}

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, v), 1 / 2.2) * 255)));

export function loadGltf(path: string): Model {
  const { json, bin } = readGltf(path);
  const notes: string[] = [];
  if (json.skins?.length) notes.push("The model has skinned meshes; they render in their bind pose (deforming isn't supported).");
  // Mesh primitives in local space.
  const meshes = (json.meshes ?? []).map((mesh: any) => mesh.primitives
    .filter((p: any) => (p.mode ?? 4) === 4)
    .map((p: any) => {
      const pos = accessor(json, bin, p.attributes.POSITION);
      const idx = p.indices !== undefined ? accessor(json, bin, p.indices).map((r) => r[0]) : pos.map((_, i) => i);
      const cols = p.attributes.COLOR_0 !== undefined ? accessor(json, bin, p.attributes.COLOR_0) : undefined;
      const mat = p.material !== undefined ? json.materials?.[p.material] : undefined;
      const f = mat?.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
      if (mat?.pbrMetallicRoughness?.baseColorTexture) notes.push("Textures are approximated by the material's base color.");
      return { pos, idx, cols, color: [toByte(f[0]), toByte(f[1]), toByte(f[2])] as [number, number, number] };
    }));
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_: any, i: number) => i);
  const clips = (json.animations ?? []).map((a: any, i: number) => {
    const channels = a.channels.map((c: any) => {
      const s = a.samplers[c.sampler];
      return { node: c.target.node, path: c.target.path, times: accessor(json, bin, s.input).map((r) => r[0]), values: accessor(json, bin, s.output), step: s.interpolation === "STEP" };
    }).filter((c: any) => c.node !== undefined && ["translation", "rotation", "scale"].includes(c.path));
    return { name: a.name ?? `clip${i + 1}`, channels, duration: Math.max(0, ...channels.map((c: any) => c.times.at(-1) ?? 0)) };
  });
  const sample = (c: any, t: number): number[] => {
    const ts = c.times;
    if (t <= ts[0]) return c.values[0];
    if (t >= ts.at(-1)) return c.values.at(-1);
    let k = 0;
    while (ts[k + 1] < t) k++;
    if (c.step) return c.values[k];
    const u = (t - ts[k]) / (ts[k + 1] - ts[k]);
    return c.path === "rotation" ? slerp(c.values[k], c.values[k + 1], u) : c.values[k].map((v: number, i: number) => v + (c.values[k + 1][i] - v) * u);
  };
  return {
    clips: clips.map((c: any) => ({ name: c.name, duration: c.duration })),
    notes: [...new Set(notes)],
    triangles(clipName?: string, t = 0) {
      const clip = clipName ? clips.find((c: any) => c.name === clipName) : undefined;
      const tris: Triangle[] = [];
      const visit = (ni: number, parent: Mat4) => {
        const n = nodes[ni];
        let local: Mat4;
        if (n.matrix) local = n.matrix;
        else {
          let tr = n.translation, rot = n.rotation, sc = n.scale;
          for (const ch of clip?.channels.filter((c: any) => c.node === ni) ?? []) {
            const v = sample(ch, t);
            if (ch.path === "translation") tr = v;
            if (ch.path === "rotation") rot = v;
            if (ch.path === "scale") sc = v;
          }
          local = trs(tr, rot, sc);
        }
        const world = mul(parent, local);
        if (n.mesh !== undefined) {
          for (const p of meshes[n.mesh]) {
            for (let i = 0; i + 2 < p.idx.length; i += 3) {
              const [ia, ib, ic] = [p.idx[i], p.idx[i + 1], p.idx[i + 2]];
              const col = p.cols
                ? ([0, 1, 2].map((k) => toByte((p.cols[ia][k] + p.cols[ib][k] + p.cols[ic][k]) / 3)) as [number, number, number])
                : p.color;
              tris.push({ a: apply(world, p.pos[ia] as Vec3), b: apply(world, p.pos[ib] as Vec3), c: apply(world, p.pos[ic] as Vec3), color: col });
            }
          }
        }
        for (const ch of n.children ?? []) visit(ch, world);
      };
      for (const r of scene) visit(r, identity());
      return tris;
    },
  };
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

export function loadObj(path: string): Model {
  const text = readFileSync(path, "utf8");
  const verts: Vec3[] = [];
  const tris: Triangle[] = [];
  const colors = new Map<string, [number, number, number]>();
  let color: [number, number, number] = [204, 204, 204];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "mtllib") {
      const mtl = join(dirname(path), p.slice(1).join(" "));
      if (existsSync(mtl)) {
        let cur = "";
        for (const l of readFileSync(mtl, "utf8").split(/\r?\n/)) {
          const q = l.trim().split(/\s+/);
          if (q[0] === "newmtl") cur = q[1];
          if (q[0] === "Kd") colors.set(cur, [toByte(+q[1]), toByte(+q[2]), toByte(+q[3])]);
        }
      }
    }
    if (p[0] === "usemtl") color = colors.get(p[1]) ?? color;
    if (p[0] === "v") verts.push([+p[1], +p[2], +p[3]]);
    if (p[0] === "f") {
      const ids = p.slice(1).map((s) => {
        const i = parseInt(s.split("/")[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) tris.push({ a: verts[ids[0]], b: verts[ids[k]], c: verts[ids[k + 1]], color });
    }
  }
  return { clips: [], notes: [], triangles: () => tris };
}

export function loadModel(path: string): Model {
  const ext = extname(path).toLowerCase();
  if (ext === ".glb" || ext === ".gltf") return loadGltf(path);
  if (ext === ".obj") return loadObj(path);
  throw new Error("Supported models: .glb, .gltf, .obj");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface View {
  /** Degrees around the vertical axis (0 = the model's front, +Z, faces the camera). */
  azimuth: number;
  /** Degrees above the horizon (0 side view, 30 isometric-ish, 90 top-down). */
  elevation: number;
}

export interface RenderOptions {
  size: number; // output width and height in px
  bands?: number; // toon bands 2..5
  /** Direction light comes from in view space (x right, y up, z toward the viewer). */
  light?: Vec3;
  ambient?: number;
}

/** Camera basis for a view: right, up, forward (toward the viewer). */
function basis(v: View): { r: Vec3; u: Vec3; f: Vec3 } {
  const az = (v.azimuth * Math.PI) / 180, el = (v.elevation * Math.PI) / 180;
  const f: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const r: Vec3 = [Math.cos(az), 0, -Math.sin(az)];
  const u: Vec3 = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return { r, u, f };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The 2D frame (in view units) that fits every given set of triangles in
 * every view: one scale and baseline for all directions and frames, so the
 * character doesn't jump or change size between them.
 */
export function fitFrame(sets: Triangle[][], views: View[]): { cx: number; minY: number; span: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const v of views) {
    const { r, u } = basis(v);
    for (const tris of sets) for (const t of tris) for (const p of [t.a, t.b, t.c]) {
      const x = dot(p, r), y = dot(p, u);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return { cx: (x0 + x1) / 2, minY: y0, span: Math.max(x1 - x0, y1 - y0) * 1.06 || 1 };
}

/**
 * Renders triangles into a size x size image: orthographic, z-buffered,
 * sampled at pixel centers (no anti-aliasing), Lambert light quantized to
 * `bands` steps of each triangle's color. Feet on the bottom row.
 */
export function renderView(tris: Triangle[], view: View, fit: { cx: number; minY: number; span: number }, o: RenderOptions): Uint8Array {
  const S = o.size;
  const out = new Uint8Array(S * S * 4);
  const depth = new Float64Array(S * S).fill(-Infinity);
  const { r, u, f } = basis(view);
  const scale = (S - 1) / fit.span;
  const L = o.light ?? [-0.5, 0.7, 0.5];
  const ll = Math.hypot(...L);
  const lv: Vec3 = [L[0] / ll, L[1] / ll, L[2] / ll];
  const bands = Math.max(2, Math.min(5, o.bands ?? 3));
  const amb = o.ambient ?? 0.35;
  for (const t of tris) {
    const P = [t.a, t.b, t.c].map((p) => ({
      x: (dot(p, r) - fit.cx) * scale + S / 2,
      y: S - 1 - (dot(p, u) - fit.minY) * scale,
      z: dot(p, f),
    }));
    // Face normal in view space (facing the camera = +z).
    const e1: Vec3 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
    const e2: Vec3 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    let n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n) || 1;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    let vn: Vec3 = [dot(n, r), dot(n, u), dot(n, f)];
    if (vn[2] < 0) vn = [-vn[0], -vn[1], -vn[2]]; // two-sided
    const lit = Math.max(0, dot(vn, lv));
    const k = amb + (1 - amb) * (Math.min(bands - 1, Math.floor(lit * bands)) / (bands - 1));
    const col = t.color.map((c) => Math.min(255, Math.round(c * k)));
    const minX = Math.max(0, Math.floor(Math.min(P[0].x, P[1].x, P[2].x))), maxX = Math.min(S - 1, Math.ceil(Math.max(P[0].x, P[1].x, P[2].x)));
    const minY = Math.max(0, Math.floor(Math.min(P[0].y, P[1].y, P[2].y))), maxY = Math.min(S - 1, Math.ceil(Math.max(P[0].y, P[1].y, P[2].y)));
    const area = (P[1].x - P[0].x) * (P[2].y - P[0].y) - (P[2].x - P[0].x) * (P[1].y - P[0].y);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((P[1].x - px) * (P[2].y - py) - (P[2].x - px) * (P[1].y - py)) / area;
        const w1 = ((P[2].x - px) * (P[0].y - py) - (P[0].x - px) * (P[2].y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const z = w0 * P[0].z + w1 * P[1].z + w2 * P[2].z;
        const i = y * S + x;
        if (z <= depth[i]) continue;
        depth[i] = z;
        out.set([col[0], col[1], col[2], 255], i * 4);
      }
    }
  }
  return out;
}

/** Elevation presets in degrees. */
export const ELEVATIONS: Record<string, number> = { side: 0, "three-quarter": 35, isometric: 30, "top-down": 89.9 };
