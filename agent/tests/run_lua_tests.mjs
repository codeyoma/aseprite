#!/usr/bin/env node
// Runs the extension's batch-mode Lua tests (agent/tests/*_test.lua) and the
// syntax check in a headless Aseprite, each with every parameter the tests
// use (ext, fixtures, guide, tmp), and prints one line per test. Works on
// macOS, Linux and Windows.
//   node agent/tests/run_lua_tests.mjs [name ...]   (default: all; names without _test.lua)
// A full passing run writes the stamp agent/tests/.lua-tests-passed.
// ASEPRITE=<binary> picks the Aseprite build (default: build/bin/aseprite[.exe]).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const bin = process.env.ASEPRITE ?? join(root, "build", "bin", process.platform === "win32" ? "aseprite.exe" : "aseprite");
if (!existsSync(bin)) {
  console.log(`No Aseprite at ${bin} (set ASEPRITE)`);
  process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), "lua-tests-"));
const args = process.argv.slice(2);
const names = args.length ? args : ["syntax_check", ...readdirSync(here).filter((f) => f.endsWith("_test.lua")).map((f) => f.slice(0, -"_test.lua".length))];

let failed = 0;
try {
  for (const n of names) {
    const script = join(here, n === "syntax_check" ? "syntax_check.lua" : `${n}_test.lua`);
    const r = spawnSync(bin, ["-b",
      "--script-param", `ext=${join(root, "agent", "extension")}`, "--script-param", `fixtures=${join(here, "fixtures")}`,
      "--script-param", `guide=${join(root, "agent", "guide")}`, "--script-param", `tmp=${tmp}`, "--script", script,
    ], { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const bad = /^FAIL|stack traceback|^\S*\.lua:\d+:/m.test(out) || !/^ALL .*PASS/m.test(out);
    if (bad) {
      failed++;
      console.log(`FAIL ${n}`);
      for (const line of out.split("\n").filter((l) => /^FAIL|\.lua:\d+:/.test(l)).slice(0, 5)) console.log(`  ${line}`);
    } else console.log(`ok   ${n}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  console.log(`LUA TESTS FAILED (${failed})`);
  process.exit(1);
}
console.log("LUA TESTS PASSED");
// A full passing run records the stamp that npm test checks (tools/check_lua_stamp.mjs).
if (!args.length) {
  const s = spawnSync(process.execPath, [join(root, "agent", "tools", "check_lua_stamp.mjs"), "--write"], { stdio: "inherit" });
  process.exit(s.status ?? 1);
}
