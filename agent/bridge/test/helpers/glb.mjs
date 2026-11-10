// Writes small GLB models for tests (#44): boxes on nodes, base colors,
// and node-transform animations.
import { writeFileSync } from "node:fs";

function box(w, h, d) {
  const x = w / 2, y = h, z = d / 2; // standing on y = 0
  const p = [[-x, 0, -z], [x, 0, -z], [x, y, -z], [-x, y, -z], [-x, 0, z], [x, 0, z], [x, y, z], [-x, y, z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4]];
  return { positions: p.flat(), indices: f.flat() };
}

/**
 * parts: [{ name, size: [w,h,d], at: [x,y,z], color: [r,g,b] (0..1), parent? }]
 * anims: [{ name, node (part name), path, times, values }]
 */
export function makeGlb(path, parts, anims = []) {
  const chunks = [];
  let offset = 0;
  const views = [], accessors = [];
  const add = (typed, type, target, minmax) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
    const comp = typed instanceof Float32Array ? 5126 : 5125;
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    accessors.push({ bufferView: views.length - 1, componentType: comp, count: typed.length / n, type, ...(minmax ?? {}) });
    return accessors.length - 1;
  };
  const meshes = [], materials = [], nodes = [];
  parts.forEach((pt, i) => {
    const b = box(...pt.size);
    const xs = [0, 1, 2].map((k) => b.positions.filter((_, j) => j % 3 === k));
    const pos = add(new Float32Array(b.positions), "VEC3", 34962, { min: xs.map((a) => Math.min(...a)), max: xs.map((a) => Math.max(...a)) });
    const idx = add(new Uint32Array(b.indices), "SCALAR", 34963);
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [...pt.color, 1] } });
    meshes.push({ primitives: [{ attributes: { POSITION: pos }, indices: idx, material: i }] });
    nodes.push({ name: pt.name, mesh: i, translation: pt.at, children: [] });
  });
  parts.forEach((pt, i) => { if (pt.parent) nodes[parts.findIndex((p) => p.name === pt.parent)].children.push(i); });
  for (const n of nodes) if (!n.children.length) delete n.children;
  const roots = parts.map((p, i) => (p.parent ? -1 : i)).filter((i) => i >= 0);
  const animations = anims.map((a) => {
    const input = add(new Float32Array(a.times), "SCALAR", undefined, { min: [Math.min(...a.times)], max: [Math.max(...a.times)] });
    const output = add(new Float32Array(a.values.flat()), a.path === "rotation" ? "VEC4" : "VEC3");
    return { name: a.name, samplers: [{ input, output, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: parts.findIndex((p) => p.name === a.node), path: a.path } }] };
  });
  const bin = Buffer.concat(chunks);
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: roots }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }], ...(animations.length ? { animations } : {}) };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  writeFileSync(path, Buffer.concat([head, ch(0x4e4f534a, js), ch(0x004e4942, bin)]));
}

/** A robot: gray body, red head, blue arm on the body that waves (rotation around z). */
export function makeRobot(path) {
  const q = (deg) => { const r = (deg * Math.PI) / 360; return [0, 0, Math.sin(r), Math.cos(r)]; };
  makeGlb(path, [
    { name: "body", size: [1, 1.4, 0.6], at: [0, 0, 0], color: [0.55, 0.55, 0.6] },
    { name: "head", size: [0.8, 0.6, 0.6], at: [0, 1.4, 0], color: [0.9, 0.1, 0.2], parent: "body" },
    { name: "arm", size: [0.25, 0.8, 0.25], at: [0.65, 0.5, 0], color: [0.1, 0.4, 0.9], parent: "body" },
  ], [{ name: "wave", node: "arm", path: "rotation", times: [0, 0.5, 1], values: [q(0), q(120), q(0)] }]);
}
