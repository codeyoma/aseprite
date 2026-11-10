// The ACP path end to end with a scripted agent (test/helpers/fake_acp_agent.mjs):
// ChatRunner -> AcpRuntime -> AcpRunner -> agent process, and the agent's
// permission request -> panel event -> chat.permission answer -> agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const agentScript = fileURLToPath(new URL("./helpers/fake_acp_agent.mjs", import.meta.url));
const logFile = join(mkdtempSync(join(tmpdir(), "fake-acp-")), "log.jsonl");
process.env.ASEPRITE_AGENT_ACP_AGENT = agentScript;
process.env.FAKE_ACP_LOG = logFile;
delete process.env.ASEPRITE_AGENT_RUNTIME;
const { ChatRunner, chatMethods } = await import("../dist/chat.js");
const { PROVIDERS } = await import("../dist/providers/index.js");

function setup() {
  const events = [];
  const waiters = [];
  const chat = new ChatRunner({ notify: (_m, ev) => { events.push(ev); for (const w of [...waiters]) w(); } }, { url: "http://x/mcp", askUrl: "http://x/ask", token: "t" });
  const methods = chatMethods(chat, "test");
  const until = (pred, ms = 10_000) => new Promise((resolve, reject) => {
    const check = () => { const ev = events.find(pred); if (ev) { waiters.splice(waiters.indexOf(check), 1); resolve(ev); } };
    waiters.push(check);
    check();
    setTimeout(() => reject(new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.type))}`)), ms).unref();
  });
  // The turn ends just after its done event.
  const ended = async (pred) => { const ev = await until(pred); await new Promise((r) => setTimeout(r, 20)); return ev; };
  return { chat, methods, events, until, ended };
}

test("a permission request reaches the panel and the answer reaches the agent", async () => {
  const { chat, methods, events, until, ended } = setup();
  try {
    methods["chat.send"]({ prompt: "run the command", provider: "claude", mode: "agent", sessions: {} });
    const perm = await until((e) => e.type === "permission");
    assert.equal(perm.text, "touch /tmp/fake-acp-file");
    assert.deepEqual(perm.options.map((o) => o.kind), ["allow_once", "reject_once"]);
    assert.ok(events.some((e) => e.type === "tool" && e.kind === "edit"), "the shell step shows as an edit");
    methods["chat.permission"]({ requestId: perm.requestId, optionId: "allow-once" });
    await ended((e) => e.type === "done");
    assert.ok(events.some((e) => e.type === "text" && e.text === "permission: allow-once"), JSON.stringify(events.filter((e) => e.type === "text")));
    assert.ok(events.some((e) => e.type === "session" && e.provider === "claude"), "the new conversation id is reported");

    // Rejecting: the agent hears the reject option.
    events.length = 0;
    methods["chat.send"]({ prompt: "again", provider: "claude", mode: "agent", sessions: {} });
    const again = await until((e) => e.type === "permission");
    methods["chat.permission"]({ requestId: again.requestId, optionId: null });
    await ended((e) => e.type === "done");
    assert.ok(events.some((e) => e.type === "text" && e.text === "permission: reject-once"));

    // Agent mode gives Claude the shell only, asking each time.
    const news = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "session/new");
    const opts = news[0].params._meta.claudeCode.options;
    assert.deepEqual(opts.tools, ["Bash"]);
    assert.ok(!opts.allowedTools.includes("Bash"));
    // and sets Claude's "Manual" permission mode, so commands that change things ask.
    const modes = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.method === "session/set_mode");
    assert.equal(modes[0]?.params.modeId, "default");
  } finally {
    chat.dispose();
  }
});

test("Stop cancels a pending permission and the turn", async () => {
  const { chat, methods, events, until, ended } = setup();
  try {
    methods["chat.send"]({ prompt: "run the command", provider: "codex", mode: "agent", sessions: {} });
    await until((e) => e.type === "permission");
    methods["chat.stop"]();
    const done = await ended((e) => e.type === "done");
    assert.equal(done.text, "Stopped.");
    assert.equal(chat.busy, false);
    // A prompt that waits is cancelled by Stop too.
    events.length = 0;
    methods["chat.send"]({ prompt: "wait for me", provider: "codex", mode: "agent", sessions: {} });
    await new Promise((r) => setTimeout(r, 300));
    methods["chat.stop"]();
    assert.equal((await ended((e) => e.type === "done")).text, "Stopped.");
  } finally {
    chat.dispose();
  }
});

test("a new developer worktree gets a new agent and a new conversation", async () => {
  const dirs = [mkdtempSync(join(tmpdir(), "wt-a-")), mkdtempSync(join(tmpdir(), "wt-b-"))];
  let n = 0;
  const events = [];
  const chat = new ChatRunner({ notify: (_m, ev) => events.push(ev) }, { url: "http://x/mcp", token: "t" },
    { developer: () => ({ cwd: dirs[Math.min(n++, 1)], branch: "dev/x" }) });
  const turn = async (sessions) => {
    events.length = 0;
    chat.send({ prompt: "wait a bit", provider: PROVIDERS.claude, mode: "developer", sessions });
    await new Promise((r) => setTimeout(r, 300));
    chat.stop();
    for (let i = 0; i < 50 && chat.busy; i++) await new Promise((r) => setTimeout(r, 20));
    return events.find((e) => e.type === "session")?.sessionId;
  };
  try {
    const before = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"method":"initialize"')).length;
    const first = await turn({});
    const again = await turn({ "claude:dev": first });
    assert.ok(first && again && first !== again, `a new conversation in the new worktree (${first}, ${again})`);
    const inits = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes('"method":"initialize"')).length - before;
    assert.equal(inits, 2, "the agent restarted in the new folder");
  } finally {
    chat.dispose();
  }
});
