// ase CLI (#30): argument parsing, errors, offline commands, the plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError, parseArgs, run } from "../dist/cli.js";

const cli = (args) => spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args], { encoding: "utf8" });

test("parses commands, positional args and flags", () => {
  assert.deepEqual(parseArgs(["snapshot", "--frame", "3", "-o", "out.png", "--json"]), {
    command: "snapshot", positional: [], flags: { frame: "3", o: "out.png", json: true },
  });
  assert.deepEqual(parseArgs(["render", "a.aseprite", "--sheet=s.png"]), { command: "render", positional: ["a.aseprite"], flags: { sheet: "s.png" } });
  assert.deepEqual(parseArgs([]).command, "help");
  assert.throws(() => parseArgs(["snapshot", "-o"]), (e) => e instanceof CliError && /needs a value/.test(e.message));
});

test("failures print ✗ and Fix: and exit 1; --json prints the error", () => {
  const r = cli(["bogus"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "✗ Unknown command: bogus\nFix: Run `ase help` for the list of commands.\n");
  const j = cli(["render", "missing.aseprite", "--gif", "x.gif", "--json"]);
  assert.equal(j.status, 1);
  assert.deepEqual(JSON.parse(j.stdout), { ok: false, error: `File not found: missing.aseprite`, fix: "Check the path." });
  assert.equal(cli(["render", fileURLToPath(import.meta.url)]).status, 1, "render needs --sheet or --gif");
});

test("offline commands", async () => {
  assert.match((await run(parseArgs(["commands", "canvas"]))).text, /CanvasSize/);
  assert.match((await run(parseArgs(["help"]))).text, /ase state/);
});

test("the Claude Code plugin is in step with the bridge", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/sync-plugin.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const plugin = JSON.parse(readFileSync(new URL("../../claude-plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(plugin.version, pkg.version);
  const mcp = JSON.parse(readFileSync(new URL("../../claude-plugin/.mcp.json", import.meta.url), "utf8"));
  assert.deepEqual(mcp.mcpServers.aseprite.args, ["${CLAUDE_PLUGIN_ROOT}/bin/aseprite-mcp.mjs"]);
});
