// Live test of the chat panel's background bridge: with no bridge running,
// sending a prompt from the panel must start `node dist/index.js --daemon`,
// run the agent, and apply the change.
// Run with Aseprite open:  node agent/tests/daemon_live.mjs
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const dir = join(homedir(), ".aseprite-agent");
const sessionFile = join(dir, "session.json");
const logFile = join(dir, "daemon.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prompt = "Add a new layer named Shadow directly under the bottom layer, with 50% opacity.";

// 0. Stop background bridges left from earlier runs; they would take the chat.
import { spawnSync } from "node:child_process";
spawnSync("pkill", ["-f", "dist/index.js --daemon"]);
await sleep(500);

// 1. Schedule a chat 4 s from now, then stop this bridge so none is running.
let c = await startBridge();
await waitForAseprite(c);
await c.call("execute_lua", { transaction: false, code: `
  if not app.sprite then local s = Sprite(16, 16); s.layers[1].name = "Gem" end
  __daemonTest = Timer{ interval = 4, ontick = function()
    __daemonTest:stop()
    AsepriteAgent.chat(${JSON.stringify(prompt)}, "claude")
  end }
  __daemonTest:start()` });
c.stop();
await sleep(1000);
console.log("bridge stopped; session file present:", existsSync(sessionFile));

// 2. The panel should start a daemon bridge.
let daemonPid;
for (let i = 0; i < 40 && !daemonPid; i++) {
  await sleep(500);
  try {
    const s = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (s.mode === "daemon") daemonPid = s.pid;
  } catch {}
}
console.log(daemonPid ? `OK   daemon started (pid ${daemonPid})` : "FAIL daemon did not start");
if (!daemonPid) process.exit(1);

// 3. Wait for the agent to finish (logged by the daemon).
let finished = false;
for (let i = 0; i < 120 && !finished; i++) {
  await sleep(2000);
  finished = existsSync(logFile) && /chat: claude finished/.test(readFileSync(logFile, "utf8"));
}
console.log(finished ? "OK   agent finished in daemon" : "FAIL agent did not finish");

// 4. Inspect the result with a fresh bridge (it takes over from the daemon).
c = await startBridge();
await waitForAseprite(c);
const state = JSON.parse(textOf(await c.call("get_state")));
const layers = state.activeSprite?.layers ?? [];
const shadow = layers.find((l) => l.name === "Shadow");
const entries = JSON.parse(textOf(await c.call("execute_lua", { transaction: false, code: `
  local out = {}
  for _, e in ipairs(AsepriteAgent.entries()) do out[#out + 1] = e.kind .. ": " .. (e.text or "") end
  return out` })).replace(/^[^{]*/, "")).value;
console.log("panel:", entries.slice(-4).map((l) => l.slice(0, 120)).join("\n       "));
const ok = finished && shadow && shadow.opacity >= 127 && shadow.opacity <= 128 && layers[layers.length - 1].name === "Shadow";
console.log(ok ? "DAEMON TEST PASSED" : `DAEMON TEST FAILED: layers ${JSON.stringify(layers.map((l) => [l.name, l.opacity]))}`);
c.stop();
process.exit(ok ? 0 : 1);
