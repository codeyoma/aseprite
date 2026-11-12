// One entry point for every committed generated file in the agent layer:
//   - the Claude Code plugin copies (agent/claude-plugin, scripts/sync-plugin.mjs);
//   - the command catalog agent/bridge/src/commands.json, from this fork's C++
//     sources (agent/tools/gen_commands.py), when src/app/commands exists.
// `npm run gen` rewrites them; `npm run gen:check` (part of `npm test`) only
// compares and fails, listing the stale files.
// The guide/skills/extension copies inside the bridge package are gitignored
// and made by `npm run build` (scripts/copy-guide.mjs), not here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { syncPlugin } from "./sync-plugin.mjs";

const bridge = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(bridge, "..", "..");
const check = process.argv.includes("--check");
const stale = [];

// The Python 3 interpreter. Windows usually has no python3 (or only the Microsoft Store stub, which exits with an
// error), but the py launcher or python.
function python() {
  const candidates = process.platform === "win32" ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []]];
  return candidates.find(([cmd, args]) => spawnSync(cmd, [...args, "-c", ""], { stdio: "ignore" }).status === 0) ?? candidates[0];
}

// Plugin copies.
stale.push(...syncPlugin({ check }));

// Command catalog. The generator always writes its output, so a check runs it
// and puts the committed file back.
const commandsJson = join(bridge, "src", "commands.json");
const generator = join(repo, "agent", "tools", "gen_commands.py");
if (!existsSync(join(repo, "src", "app", "commands"))) {
  console.log("skipped commands.json: no src/app/commands (not a full Aseprite checkout)");
} else {
  const before = existsSync(commandsJson) ? readFileSync(commandsJson, "utf8") : undefined;
  const [py, pyArgs] = python();
  const r = spawnSync(py, [...pyArgs, generator], { cwd: repo, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    if (before !== undefined) writeFileSync(commandsJson, before);
    console.error(`gen_commands.py failed: ${r.error?.message ?? r.stderr}`);
    process.exit(1);
  }
  const after = readFileSync(commandsJson, "utf8");
  if (after.replace(/\r\n/g, "\n") !== before?.replace(/\r\n/g, "\n")) {
    stale.push(commandsJson);
    if (check && before !== undefined) writeFileSync(commandsJson, before);
    else console.log(`updated ${commandsJson}`);
  }
}

if (check && stale.length) {
  console.error(`Generated files are out of date; run npm run gen (in agent/bridge):\n${stale.map((p) => "  " + relative(repo, p)).join("\n")}`);
  process.exit(1);
}
if (check) console.log("generated files are up to date");
