#!/usr/bin/env node
// Runs live tests (agent/tests/<name>_live.mjs) against the running Aseprite
// with each provider, and prints their PASS/FAIL lines and a summary.
// Arguments are passed as an array (no shell word splitting), scratch
// folders are made for tests that need one, and each run has a timeout.
//
// Results come in two categories:
//   tool   the skill evals run against Aseprite (eval_live.mjs): deterministic,
//          no model, one result per eval;
//   agent  chat tests: hard checks (FAIL) prove the feature ran, soft checks
//          (SOFT-FAIL) score the model's choices and never fail the run.
// The exit code is 1 only when a hard check failed.
//
//   node agent/tests/run_live.mjs [options] <name>[:arg[:arg]] ...
//     --providers claude,codex   which agents (default both)
//     --restart                  restart Aseprite (build/bin/aseprite) first
//     --all                      every skill live test (not developer or daemon)
//     --evals                    every skill eval against Aseprite (no model; eval:<skill>[:<skill>] for some)
//     --timeout <minutes>        per run (default 15)
//
// Examples:
//   node agent/tests/run_live.mjs --restart shading normals
//   node agent/tests/run_live.mjs --providers codex export:unity
//   node agent/tests/run_live.mjs --evals
//   node agent/tests/run_live.mjs eval:shade-sprite:dither
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
const NO_PROVIDER = new Set(["permission", "daemon", "eval"]);
// Environment some tests need; "@tmp" is a fresh scratch folder.
const ENV = { commands: { ASEPRITE_AGENT_COMMANDS: "@tmp" } };
const NOT_IN_ALL = new Set(["developer", "developer_build", "daemon", "chat", "pixel_snap", "eval"]);
// Tests that use no model (the rest are agent tests).
const TOOL = new Set(["eval"]);
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
  else if (a === "--evals") names.push("eval");
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
// { category: "tool" | "agent", name, provider, ok, soft: [names of SOFT-FAIL checks] }
const results = [];
for (const spec of names) {
  const [name, ...extra] = spec.split(":");
  const script = join(here, `${name}_live.mjs`);
  const category = TOOL.has(name) ? "tool" : "agent";
  if (!existsSync(script)) { results.push({ category, name: spec, provider: "-", ok: false, missing: true, soft: [] }); continue; }
  // Extras fill the template's plain slots in order (export:unity sets the engine); the rest are appended.
  const rest = [...extra];
  const base = (ARGS[name] ?? []).map((a) => (a.startsWith("@") || !rest.length ? a : rest.shift())).concat(rest);
  for (const provider of NO_PROVIDER.has(name) ? [undefined] : providers) {
    const args = [...base.map(expand), ...(provider ? [provider] : [])];
    const t0 = Date.now();
    const env = Object.fromEntries(Object.entries(ENV[name] ?? {}).map(([k, v]) => [k, expand(v)]));
    const { code, out } = await run(script, args, env);
    const lines = out.split("\n").filter((l) => /^(PASS|FAIL|SOFT-PASS|SOFT-FAIL|SKIP)\b|^SOFT \d|TEST (PASSED|FAILED)|TIMEOUT|^Error|^WARNING/.test(l));
    const ok = code === 0 && !lines.some((l) => /^FAIL|TIMEOUT/.test(l));
    const softFails = lines.filter((l) => /^SOFT-FAIL /.test(l)).map((l) => l.slice(10).replace(/ [[{"].*$/, ""));
    console.log(`### ${name}${provider ? ` (${provider})` : ""}: ${ok ? "ok" : "FAILED"}${softFails.length ? ` (${softFails.length} soft)` : ""} in ${Math.round((Date.now() - t0) / 1000)}s`);
    for (const l of lines) if (!ok || !/^(PASS|SOFT-PASS)\b/.test(l)) console.log(`  ${l.slice(0, 300)}`);
    if (!ok && !lines.length) console.log(out.split("\n").slice(-8).map((l) => `  ${l}`).join("\n"));
    // An eval run reports one result per eval ("PASS eval <skill>").
    const perEval = category === "tool" ? lines.map((l) => /^(PASS|FAIL) eval (\S+)/.exec(l)).filter(Boolean) : [];
    if (perEval.length) {
      for (const m of perEval) results.push({ category, name: m[2], provider: "-", ok: m[1] === "PASS", soft: [] });
      // A crash after the last eval (or a timeout) still fails the run.
      if (!ok && perEval.every((m) => m[1] === "PASS")) results.push({ category, name, provider: "-", ok: false, soft: [] });
    } else results.push({ category, name, provider: provider ?? "-", ok, soft: softFails });
  }
}

const label = (r) => `${r.name}${r.provider !== "-" ? ` (${r.provider})` : ""}${r.missing ? " [missing]" : ""}`;
console.log("");
for (const category of ["tool", "agent"]) {
  const rs = results.filter((r) => r.category === category);
  if (!rs.length) continue;
  const failed = rs.filter((r) => !r.ok);
  const soft = rs.filter((r) => r.soft.length);
  console.log(`${category}: ${rs.length - failed.length}/${rs.length} passed${failed.length ? `; failed: ${failed.map(label).join(", ")}` : ""}`);
  if (soft.length) {
    console.log(`${category}: ${soft.reduce((n, r) => n + r.soft.length, 0)} soft failures (model choices, not counted):`);
    for (const r of soft) console.log(`  ${label(r)}: ${r.soft.join("; ").slice(0, 300)}`);
  }
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
