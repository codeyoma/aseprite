// The agent home's bridge pin (the user's stable instance): another bridge started with that home must not take it over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A file:// URL: Windows paths (D:\\...) are not valid ESM import specifiers.
const dist = new URL("../dist/session.js", import.meta.url).href;
const run = (home, code) => execFileSync(process.execPath, ["--input-type=module", "-e",
  `const s = await import(${JSON.stringify(dist)}); ${code}`], { env: { ...process.env, ASEPRITE_AGENT_HOME: home }, encoding: "utf8" }).trim();

test("a home pinned to the stable bridge keeps its bridge.json; an unpinned home records the newest bridge", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const stable = join(home, "stable-bridge.js"), dev = join(home, "dev-bridge.js");
  writeFileSync(stable, "");
  writeFileSync(dev, "");
  writeFileSync(join(home, "bridge.json"), JSON.stringify({ bridgePath: stable, version: "s", pinned: true }));
  assert.equal(run(home, `console.log(s.homeBelongsToAnother(${JSON.stringify(dev)}))`), "true");
  assert.equal(run(home, `console.log(s.homeBelongsToAnother(${JSON.stringify(stable)}))`), "false");
  run(home, `s.recordBridge(${JSON.stringify(dev)}, "d")`);
  assert.equal(JSON.parse(readFileSync(join(home, "bridge.json"), "utf8")).bridgePath, stable, "the pin stays");
  run(home, `s.recordBridge(${JSON.stringify(stable)}, "s2")`);
  assert.equal(JSON.parse(readFileSync(join(home, "bridge.json"), "utf8")).pinned, true, "the pinned bridge itself keeps the pin");

  const open = mkdtempSync(join(tmpdir(), "agent-home-"));
  writeFileSync(join(open, "bridge.json"), JSON.stringify({ bridgePath: stable, version: "s" }));
  run(open, `s.recordBridge(${JSON.stringify(dev)}, "d")`);
  assert.equal(JSON.parse(readFileSync(join(open, "bridge.json"), "utf8")).bridgePath, dev, "no pin: the newest bridge records itself");
});

test("--dev picks the dev instance's home and sets it for what the bridge starts; ASEPRITE_AGENT_HOME still wins", () => {
  const dev = mkdtempSync(join(tmpdir(), "agent-dev-home-")), own = mkdtempSync(join(tmpdir(), "agent-home-"));
  const homes = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    `const s = await import(${JSON.stringify(dist)}); console.log(JSON.stringify([s.sessionDir, process.env.ASEPRITE_AGENT_HOME ?? null]))`,
    "--", "--dev"], { env: { ...process.env, ASEPRITE_AGENT_DEV_HOME: dev, ...env }, encoding: "utf8" }));
  assert.deepEqual(homes({ ASEPRITE_AGENT_HOME: undefined }), [dev, dev]);
  assert.deepEqual(homes({ ASEPRITE_AGENT_HOME: own }), [own, own]);
});

test("a --daemon started in a home pinned to another bridge starts that bridge and exits", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const stable = join(home, "stable.js");
  writeFileSync(stable, `require("fs").writeFileSync(require("path").join(process.env.ASEPRITE_AGENT_HOME, "started.txt"), process.argv.slice(2).join(" "));`);
  writeFileSync(join(home, "bridge.json"), JSON.stringify({ bridgePath: stable, version: "s", pinned: true }));
  const index = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  execFileSync(process.execPath, [index, "--daemon"], { env: { ...process.env, ASEPRITE_AGENT_HOME: home }, timeout: 15_000 });
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 50 && !existsSync(join(home, "started.txt")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(join(home, "started.txt"), "utf8"), "--daemon");
});
