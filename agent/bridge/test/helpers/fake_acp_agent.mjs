#!/usr/bin/env node
// A scripted ACP agent for tests (ASEPRITE_AGENT_ACP_AGENT): newline-
// delimited JSON-RPC on stdio, the way claude-agent-acp and codex-acp talk.
// Each prompt asks the client for permission to run a shell command and
// replies with the kind of the option it was given ("permission:
// allow-once", "permission: reject-once"), so the permission round trip is
// exercised without a model. A prompt containing "wait" stays open until
// session/cancel. FAKE_ACP_LOG appends every message it receives.
//
// The permission request has the shape the real agent sends: a session
// created with Claude's _meta.claudeCode gets claude-agent-acp's (options
// "allow-once"/"reject"), any other codex-acp's (options "allow_once",
// "allow_for_session", "decline", "cancel"). The recorded shapes are in
// test/fixtures/acp-*-permission.jsonl; acp_permission.test.mjs checks this
// fake against them and against the ACP SDK's schemas.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const COMMAND = "touch /tmp/fake-acp-file";

/** What each real agent sends for a shell command it wants to run. */
export const AGENTS = {
  claude: {
    toolCallId: "toolu_01FakeAcpShell",
    // claude-agent-acp emits the tool_call before it asks (ensureToolCallEmitted).
    toolCall: (id) => ({
      toolCallId: id,
      name: "Bash",
      status: "pending",
      rawInput: { command: COMMAND, description: "Create an empty file" },
      title: COMMAND,
      kind: "execute",
      content: [{ type: "content", content: { type: "text", text: "Create an empty file" } }],
    }),
    meta: { claudeCode: { toolName: "Bash" } },
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  },
  codex: {
    toolCallId: "call_FakeAcpShell",
    // codex-acp asks before the command starts, so no tool_call comes first.
    toolCall: (id) => ({
      toolCallId: id,
      kind: "execute",
      status: "pending",
      title: COMMAND,
      rawInput: { command: COMMAND, cwd: process.cwd() },
    }),
    options: [
      { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
      { optionId: "allow_for_session", name: "Yes, and don't ask again for this command in this session", kind: "allow_always" },
      { optionId: "decline", name: "No, continue without running it", kind: "reject_once" },
      { optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
    ],
  },
};

/** The session/request_permission params the fake sends for an agent. */
export function permissionRequest(agent, sessionId) {
  const a = AGENTS[agent];
  return { sessionId, toolCall: a.toolCall(a.toolCallId), options: a.options };
}

/** The fake's replies and notifications, for the conformance test. */
export const MESSAGES = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }),
  newSession: (n) => ({ sessionId: `fake-session-${process.pid}-${n}` }),
  setMode: () => ({}),
  prompt: (stopReason) => ({ stopReason }),
  /** session/update params: what a turn of `agent` sends, `allowed` or not. */
  updates(agent, sessionId, allowed) {
    const a = AGENTS[agent];
    const tc = a.toolCall(a.toolCallId);
    const meta = a.meta ? { _meta: a.meta } : {};
    const list = [];
    if (agent === "claude") list.push({ sessionUpdate: "tool_call", ...tc, ...meta });
    else if (allowed) list.push({ sessionUpdate: "tool_call", ...tc, status: "in_progress" });
    if (agent === "claude" || allowed) list.push({ sessionUpdate: "tool_call_update", toolCallId: a.toolCallId, status: allowed ? "completed" : "failed", ...meta });
    return list.map((update) => ({ sessionId, update }));
  },
  say: (sessionId, text) => ({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }),
};

function main() {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const log = (msg) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(msg) + "\n");
  const pending = new Map(); // our request id -> resolve
  const prompts = new Map(); // session id -> { id, cancel }
  const agentOf = new Map(); // session id -> "claude" | "codex"
  let nextId = 1, nextSession = 1;
  const ask = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  const update = (params) => send({ method: "session/update", params });

  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    log(msg);
    if (msg.id !== undefined && !msg.method) {
      pending.get(msg.id)?.(msg.result ?? { error: msg.error });
      pending.delete(msg.id);
      return;
    }
    const { id, method, params } = msg;
    if (method === "initialize") return send({ id, result: MESSAGES.initialize() });
    if (method === "session/new") {
      const result = MESSAGES.newSession(nextSession++);
      agentOf.set(result.sessionId, params?._meta?.claudeCode ? "claude" : "codex");
      return send({ id, result });
    }
    if (method === "session/set_mode") return send({ id, result: MESSAGES.setMode() });
    if (method === "session/cancel") {
      const p = prompts.get(params.sessionId);
      if (p) p.cancel();
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId;
      const agent = agentOf.get(sessionId) ?? "codex";
      const text = params.prompt?.find((b) => b.type === "text")?.text ?? "";
      let cancelled = false;
      const done = (stopReason) => { prompts.delete(sessionId); send({ id, result: MESSAGES.prompt(stopReason) }); };
      prompts.set(sessionId, { id, cancel: () => { cancelled = true; done("cancelled"); } });
      if (/\bwait\b/.test(text)) return; // until session/cancel
      const req = permissionRequest(agent, sessionId);
      if (agent === "claude") update(MESSAGES.updates(agent, sessionId, true)[0]);
      const answer = await ask("session/request_permission", req);
      if (cancelled) return;
      const chosen = answer?.outcome?.outcome === "selected" ? req.options.find((o) => o.optionId === answer.outcome.optionId) : undefined;
      const allowed = !!chosen?.kind.startsWith("allow");
      const after = MESSAGES.updates(agent, sessionId, allowed);
      for (const u of agent === "claude" ? after.slice(1) : after) update(u);
      update(MESSAGES.say(sessionId, `permission: ${chosen ? chosen.kind.replace("_", "-") : "cancelled"}`));
      return done("end_turn");
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: `fake agent: no ${method}` } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
