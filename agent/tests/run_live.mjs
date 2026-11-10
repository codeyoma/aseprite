#!/usr/bin/env node
// Runs live tests (agent/tests/<name>_live.mjs) against the running Aseprite
// with each provider, and prints their PASS/FAIL lines and a summary.
// Arguments are passed as an array (no shell word splitting), scratch
// folders are made for tests that need one, and each run has a timeout.
//
//   node agent/tests/run_live.mjs [options] <name>[:arg[:arg]] ...
//     --providers claude,codex   which agents (default both)
//     --restart                  restart Aseprite (build/bin/aseprite) first
//     --all                      every skill live test (not developer or daemon)
//     --timeout <minutes>        per run (default 15)
//
// Examples:
//   node agent/tests/run_live.mjs --restart shading normals
//   node agent/tests/run_live.mjs --providers codex export:unity
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// Arguments before the provider: "@tmp" is a fresh scratch folder, "@ref" a
// 4-color reference PNG; name:value replaces the plain ones in order. Tests that don't take a provider run once.
const ARGS = {
  export: ["@tmp", "godot"], masks_cutout: ["@tmp"], model: ["@tmp"], normals: ["@tmp"], recreate: ["@tmp"],
  sheet: ["@tmp"], tileset: ["@tmp"], voxels: ["@tmp"], color_skills: ["@ref"],
};
const NO_PROVIDER = new Set(["permission", "daemon"]);
// Environment some tests need; "@tmp" is a fresh scratch folder.
const ENV = { commands: { ASEPRITE_AGENT_COMMANDS: "@tmp" } };
const NOT_IN_ALL = new Set(["developer", "developer_build", "daemon", "chat", "pixel_snap"]);
const liveTests = () => readdirSync(here).filter((f) => f.endsWith("_live.mjs") && f !== "run_live.mjs").map((f) => f.slice(0, -9));

const argv = process.argv.slice(2);
let providers = ["claude", "codex"], restart = false, minutes = 15;
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--providers") providers = argv[++i].split(",");
  else if (a === "--restart") restart = true;
  else if (a === "--timeout") minutes = Number(argv[++i]);
  else if (a === "--all") names.push(...liveTests().filter((n) => !NOT_IN_ALL.has(n)));
  else names.push(a);
}
if (!names.length) {
  console.log(`Live tests: ${liveTests().join(" ")}`);
  process.exit(0);
}

function refPng() {
  const file = join(mkdtempSync(join(tmpdir(), "live-ref-")), "ref4.png");
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from "node:fs";
    import { PNG } from ${JSON.stringify(join(here, "..", "bridge", "node_modules", "pngjs", "lib", "png.js"))};
    const p = new PNG({ width: 8, height: 8 });
    const c = [[0x1d,0x2b,0x53],[0x7e,0x25,0x53],[0xff,0xa3,0x00],[0x29,0xad,0xff]];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.data.set([...c[(x >> 2) + 2 * (y >> 2)], 255], (y * 8 + x) * 4);
    writeFileSync(${JSON.stringify(file)}, PNG.sync.write(p));`]);
  if (out.status !== 0) throw new Error(String(out.stderr));
  return file;
}
const expand = (a) => (a === "@tmp" ? mkdtempSync(join(tmpdir(), "live-")) : a === "@ref" ? refPng() : a);

async function restartAseprite() {
  spawnSync("pkill", ["-x", "aseprite"]);
  await new Promise((r) => setTimeout(r, 1000));
  const bin = join(root, "build", "bin", "aseprite");
  if (!existsSync(bin)) throw new Error(`No Aseprite at ${bin}`);
  spawn(bin, [], { detached: true, stdio: "ignore" }).unref();
  await new Promise((r) => setTimeout(r, 8000));
}

function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { p.kill("SIGTERM"); out += "\nTIMEOUT"; }, minutes * 60_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

if (restart) await restartAseprite();
const results = [];
for (const spec of names) {
  const [name, ...extra] = spec.split(":");
  const script = join(here, `${name}_live.mjs`);
  if (!existsSync(script)) { results.push([spec, "-", "MISSING"]); continue; }
  // Extras fill the template's plain slots in order (export:unity sets the engine); the rest are appended.
  const rest = [...extra];
  const base = (ARGS[name] ?? []).map((a) => (a.startsWith("@") || !rest.length ? a : rest.shift())).concat(rest);
  for (const provider of NO_PROVIDER.has(name) ? [undefined] : providers) {
    const args = [...base.map(expand), ...(provider ? [provider] : [])];
    const t0 = Date.now();
    const env = Object.fromEntries(Object.entries(ENV[name] ?? {}).map(([k, v]) => [k, expand(v)]));
    const { code, out } = await run(script, args, env);
    const lines = out.split("\n").filter((l) => /^(PASS|FAIL)\b|TEST (PASSED|FAILED)|TIMEOUT|^Error|^WARNING/.test(l));
    const ok = code === 0 && !lines.some((l) => /^FAIL|TIMEOUT/.test(l));
    console.log(`### ${name}${provider ? ` (${provider})` : ""}: ${ok ? "ok" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const l of lines) if (!ok || !/^PASS/.test(l)) console.log(`  ${l.slice(0, 300)}`);
    if (!ok && !lines.length) console.log(out.split("\n").slice(-8).map((l) => `  ${l}`).join("\n"));
    results.push([name, provider ?? "-", ok ? "ok" : "FAILED"]);
  }
}
const failed = results.filter((r) => r[2] !== "ok");
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((r) => `${r[0]} (${r[1]})`).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
