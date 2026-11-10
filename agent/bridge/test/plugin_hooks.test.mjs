// Claude Code plugin hooks (#81): the look reminder after edits, the bridge
// status at session start, the bridge's GET /status, and the chat's prompt.
// The hook scripts run as Claude Code runs them: a node process with the hook
// JSON on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after } from "node:test";

// Temp folders made by these tests, removed at the end.
const temps = [];
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../dist/tools.js";
import { LOOK_NUDGE } from "../dist/look.js";
import { SYSTEM_PROMPT } from "../dist/chat.js";
import { AsepriteLink } from "../dist/aseprite.js";

const hooksDir = fileURLToPath(new URL("../../claude-plugin/hooks/", import.meta.url));
const hooksJson = JSON.parse(readFileSync(join(hooksDir, "hooks.json"), "utf8"));
const PREFIX = "mcp__plugin_aseprite_aseprite__";

/** Runs a hook script with stdin; resolves { stdout, code, ms }. */
function runHook(script, stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(hooksDir, script)], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

const context = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : undefined);

test("the PostToolUse matcher covers exactly the edit tools of the Tool table", () => {
  const [entry] = hooksJson.hooks.PostToolUse;
  const matcher = new RegExp(entry.matcher);
  for (const t of TOOLS) assert.equal(matcher.test(PREFIX + t.name), t.kind === "edit", t.name);
  assert.ok(matcher.test(PREFIX + "execute_lua"));
  assert.ok(!matcher.test("mcp__other__execute_lua"));
  assert.ok(!matcher.test(PREFIX + "execute_lua_x"));
  assert.match(entry.hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/look-nudge\.mjs/);
  assert.match(hooksJson.hooks.SessionStart[0].hooks[0].command, /session-status\.mjs/);
  const list = JSON.parse(readFileSync(join(hooksDir, "edit-tools.json"), "utf8"));
  assert.deepEqual(list.tools, TOOLS.filter((t) => t.kind === "edit").map((t) => t.name).sort());
  assert.equal(list.nudge, LOOK_NUDGE);
});

test("look-nudge reminds once per session, only after edit tools", async () => {
  const env = { CLAUDE_PLUGIN_DATA: tempDir("look-nudge-") };
  const call = (session_id, tool) =>
    runHook("look-nudge.mjs", JSON.stringify({ session_id, hook_event_name: "PostToolUse", tool_name: PREFIX + tool }), env);

  const read = await call("s1", "snapshot");
  assert.equal(read.code, 0);
  assert.equal(read.stdout, "", "a read tool gets no reminder");

  const first = await call("s1", "execute_lua");
  assert.equal(first.code, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(out.hookSpecificOutput.additionalContext, LOOK_NUDGE);
  assert.match(LOOK_NUDGE, /snapshot/);
  assert.match(LOOK_NUDGE, /filmstrip/);

  assert.equal((await call("s1", "write_pixels")).stdout, "", "second edit in the same session: silent");
  assert.equal(context((await call("s2", "write_pixels")).stdout), LOOK_NUDGE, "a new session is reminded again");
  assert.equal((await call("s3", "not_a_tool")).stdout, "");

  const bad = await runHook("look-nudge.mjs", "not json", env);
  assert.deepEqual([bad.code, bad.stdout], [0, ""]);
  // Path characters in a session id stay inside the state folder.
  assert.equal(context((await call("../x", "execute_lua")).stdout), LOOK_NUDGE);
});

/** A HOME whose ~/.aseprite-agent/session.json points at port (or none). */
function home(port) {
  const dir = tempDir("session-status-");
  if (port !== undefined) {
    mkdirSync(join(dir, ".aseprite-agent"));
    writeFileSync(join(dir, ".aseprite-agent", "session.json"), JSON.stringify({ port, token: "t", pid: 1 }));
  }
  return { HOME: dir, USERPROFILE: dir };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function closedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sessionStart = (env) => runHook("session-status.mjs", JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }), env);

test("session-status is silent without a bridge, within its 400 ms budget", async () => {
  const none = await sessionStart(home());
  assert.deepEqual([none.code, none.stdout], [0, ""]);

  const closed = await sessionStart(home(await closedPort()));
  assert.deepEqual([closed.code, closed.stdout], [0, ""]);

  // A port that accepts and never answers: the probe gives up at 400 ms.
  const hang = createServer(() => {});
  const port = await listen(hang);
  try {
    const slow = await sessionStart(home(port));
    assert.deepEqual([slow.code, slow.stdout], [0, ""]);
    assert.ok(slow.ms < 400 + 600, `took ${slow.ms} ms (node start-up plus the 400 ms budget)`);
  } finally {
    hang.closeAllConnections();
    hang.close();
  }

  // A bridge too old for /status answers 426: silent.
  const old = createServer((req, res) => res.writeHead(426).end());
  const oldPort = await listen(old);
  try {
    assert.equal((await sessionStart(home(oldPort))).stdout, "");
  } finally {
    old.close();
  }
});

test("session-status reports connected and not connected", async () => {
  let reply = { connected: true, aseprite: "1.3.99" };
  const stub = createServer((req, res) => {
    assert.equal(req.url, "/status");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  const port = await listen(stub);
  try {
    const on = await sessionStart(home(port));
    const out = JSON.parse(on.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /^Aseprite 1\.3\.99 is connected/);
    reply = { connected: false };
    assert.match(context((await sessionStart(home(port))).stdout), /not connected/);
  } finally {
    stub.close();
  }
});

test("the bridge answers GET /status on its WebSocket port", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connected, false);
    assert.ok(!JSON.stringify(body).includes(link.token), "never the token");
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 426);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { headers: { origin: "https://example.com" } })).status, 403);
    const status = await sessionStart(home(port));
    assert.match(context(status.stdout), /not connected/);
  } finally {
    link.stop();
  }
});

test("the in-app chat's system prompt carries the same reminder", () => {
  assert.ok(SYSTEM_PROMPT.includes(LOOK_NUDGE));
});
