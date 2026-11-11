#!/usr/bin/env node
// #95 benchmark: put_images (base64 vs binary rgba) and check's pixel rules on
// twelve 256x256 frames, in a headless Aseprite (see native_bench.lua).
//
//   node agent/tests/bench/native_bench.mjs [runs]
//   ASEPRITE=<binary> node agent/tests/bench/native_bench.mjs   (default: build/bin/aseprite)
//
// Also times the bridge side: base64 encoding of the 12 images vs packing
// them into one binary frame (protocol.ts packBinary).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const bin = process.env.ASEPRITE ?? join(root, "build", "bin", process.platform === "win32" ? "aseprite.exe" : "aseprite");
const runs = process.argv[2] ?? "5";
if (!existsSync(bin)) {
  console.error(`No Aseprite at ${bin} (set ASEPRITE)`);
  process.exit(2);
}

const r = spawnSync(bin, ["-b", "--script-param", `ext=${join(root, "agent", "extension")}`, "--script-param", `runs=${runs}`,
  "--script", join(here, "native_bench.lua")], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
for (const line of out.split("\n")) if (line.startsWith("BENCH") || /\.lua:\d+:/.test(line)) console.log(line);

// Bridge side (needs the bridge built: cd agent/bridge && npm run build).
const protocolJs = join(root, "agent", "bridge", "dist", "protocol.js");
if (existsSync(protocolJs)) {
  const { packBinary } = await import(pathToFileURL(protocolJs).href);
  const imgs = Array.from({ length: 12 }, (_, f) => new Uint8Array(256 * 256 * 4).map((_, i) => (i * 7 + f) & 255));
  const median = (fn) => {
    const t = [];
    for (let i = 0; i < Number(runs); i++) {
      const c = performance.now();
      fn();
      t.push(performance.now() - c);
    }
    return t.sort((a, b) => a - b)[(t.length - 1) >> 1];
  };
  const params = () => ({ images: imgs.map((rgba, f) => ({ width: 256, height: 256, rgba, frame: f + 1 })) });
  const b64 = median(() => JSON.stringify({ images: imgs.map((d) => Buffer.from(d.buffer).toString("base64")) }));
  console.log(`BENCH bridge base64 + JSON    ${b64.toFixed(2).padStart(8)} ms`);
  if (packBinary) {
    const bin2 = median(() => { const p = packBinary(params()); JSON.stringify(p.params); });
    console.log(`BENCH bridge packBinary + JSON${bin2.toFixed(2).padStart(8)} ms`);
  }
}
