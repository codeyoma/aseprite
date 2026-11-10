#!/usr/bin/env node
// Checks for the Aseprite extension (agent/extension) that no test catches:
//  - File, shell and socket access only in agent.lua. Aseprite asks the
//    user's permission per script file, so a write from another module
//    blocks on a dialog (save_palette did, before it moved to agent.lua).
//    Other modules get these as functions passed in from agent.lua.
//  - Every Lua module is valid Lua (luac -p when installed).
// Run by `npm test` in agent/bridge and by CI.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const TRUSTED = "agent.lua";
const FORBIDDEN = [
  [/:saveAs\(|:saveCopyAs\(/, "saving files"],
  [/\bio\.(open|popen|lines)\(/, "file access"],
  [/\bos\.(execute|remove|rename|exit)\(/, "shell and file operations"],
  [/\bWebSocket\(/, "sockets"],
];

const problems = [];
const modules = readdirSync(dir).filter((f) => f.endsWith(".lua") && f !== "__pref.lua");
for (const file of modules) {
  if (file === TRUSTED) continue;
  readFileSync(join(dir, file), "utf8").split("\n").forEach((line, i) => {
    const code = line.replace(/--.*$/, "");
    for (const [re, what] of FORBIDDEN) {
      if (re.test(code)) problems.push(`${file}:${i + 1}: ${what} belongs in ${TRUSTED} (pass a function in): ${line.trim()}`);
    }
  });
}

const luac = ["luac", "luac5.4"].find((c) => spawnSync(c, ["-v"]).status === 0);
if (luac) {
  for (const file of modules) {
    const r = spawnSync(luac, ["-p", join(dir, file)], { encoding: "utf8" });
    if (r.status !== 0) problems.push(r.stderr.trim());
  }
} else console.log("check_extension: no luac on PATH; skipping the Lua syntax check (agent/tests/run_lua_tests.sh checks it in Aseprite)");

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check_extension: ${modules.length} modules ok`);
