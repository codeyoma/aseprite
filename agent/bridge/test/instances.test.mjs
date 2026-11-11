// Instances (docs/INSTANCES.md): the dev and stable instances get separate
// folders and environments, and the extension install links or copies.
// Runs with the bridge tests (npm test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV, STABLE, defaultUserFolder, installExtension, instanceEnv, IS_WINDOWS } from "../../tools/instances.mjs";
import { agentOnly } from "../../tools/stable.mjs";

test("dev and stable never share a folder", () => {
  assert.notEqual(DEV.home, STABLE.home);
  assert.notEqual(DEV.userFolder, STABLE.userFolder);
  assert.equal(STABLE.userFolder, defaultUserFolder());
  assert.deepEqual(Object.keys(instanceEnv(DEV)).sort(), ["ASEPRITE_AGENT_HOME", "ASEPRITE_USER_FOLDER"]);
  assert.deepEqual(Object.keys(instanceEnv(STABLE)), ["ASEPRITE_AGENT_HOME"]);
});

test("the extension is linked for dev and copied for stable; removed files go", () => {
  const src = mkdtempSync(join(tmpdir(), "ext-src-")), user = mkdtempSync(join(tmpdir(), "ext-user-"));
  writeFileSync(join(src, "agent.lua"), "-- a");
  writeFileSync(join(src, "package.json"), "{}");
  writeFileSync(join(src, "notes.txt"), "not copied");
  const inst = { userFolder: user, extensionSource: src };
  const dest = join(user, "extensions", "aseprite-agent");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "gone.lua"), "-- stale");
  installExtension(inst, { link: true });
  assert.equal(lstatSync(join(dest, "agent.lua")).isSymbolicLink(), !IS_WINDOWS);
  assert.ok(!existsSync(join(dest, "gone.lua")) && !existsSync(join(dest, "notes.txt")));
  installExtension(inst, { link: false });
  assert.equal(lstatSync(join(dest, "agent.lua")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(dest, "agent.lua"), "utf8"), "-- a");
});

test("only changes outside agent/ need an Aseprite build", () => {
  assert.equal(agentOnly("agent/extension/chat_panel.lua"), true);
  assert.equal(agentOnly("README.md"), true);
  assert.equal(agentOnly("src/app/ui/main_window.cpp"), false);
  assert.equal(agentOnly("laf"), false);
});
