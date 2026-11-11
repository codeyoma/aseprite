// The agent home's bridge pin (the user's stable instance): another bridge started with that home must not take it over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/session.js", import.meta.url));
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

  const open = mkdtempSync(join(tmpdir(), "agent-home-"));
  writeFileSync(join(open, "bridge.json"), JSON.stringify({ bridgePath: stable, version: "s" }));
  run(open, `s.recordBridge(${JSON.stringify(dev)}, "d")`);
  assert.equal(JSON.parse(readFileSync(join(open, "bridge.json"), "utf8")).bridgePath, dev, "no pin: the newest bridge records itself");
});
