#!/usr/bin/env node
// Starts the aseprite-agent MCP bridge for the Claude Code plugin, from any
// folder. It uses, in order:
//   1. ASEPRITE_AGENT_BRIDGE (path to the bridge's dist/index.js);
//   2. the bridge recorded in ~/.aseprite-agent/bridge.json (written by every
//      bridge that has run, e.g. from a clone of codeyoma/aseprite);
//   3. `npx -y aseprite-agent@<version>` from npm.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;

function recorded() {
  try {
    const { bridgePath } = JSON.parse(readFileSync(join(homedir(), ".aseprite-agent", "bridge.json"), "utf8"));
    return bridgePath && existsSync(bridgePath) ? bridgePath : undefined;
  } catch {
    return undefined;
  }
}

const bridge = process.env.ASEPRITE_AGENT_BRIDGE || recorded();
const [cmd, args] = bridge
  ? [process.execPath, [bridge]]
  : [process.platform === "win32" ? "npx.cmd" : "npx", ["-y", `aseprite-agent@${VERSION}`]];

const child = spawn(cmd, args, { stdio: "inherit" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
