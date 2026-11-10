#!/usr/bin/env node
// A scripted ACP agent for tests (ASEPRITE_AGENT_ACP_AGENT): newline-
// delimited JSON-RPC on stdio, the way claude-agent-acp and codex-acp talk.
// Each prompt asks the client for permission to run a shell command and
// replies with what it was told, so the permission round trip is exercised
// without a model. A prompt containing "wait" stays open until
// session/cancel. FAKE_ACP_LOG appends every message it receives.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const log = (msg) => process.env.FAKE_ACP_LOG && appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(msg) + "\n");
const pending = new Map(); // our request id -> resolve
const prompts = new Map(); // session id -> { id, cancel }
let nextId = 1, nextSession = 1;
const ask = (method, params) => new Promise((resolve) => {
  const id = `fake-${nextId++}`;
  pending.set(id, resolve);
  send({ id, method, params });
});
const say = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

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
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  if (method === "session/new") return send({ id, result: { sessionId: `fake-session-${process.pid}-${nextSession++}` } });
  if (method === "session/set_mode") return send({ id, result: {} });
  if (method === "session/cancel") {
    const p = prompts.get(params.sessionId);
    if (p) p.cancel();
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    const text = params.prompt?.find((b) => b.type === "text")?.text ?? "";
    let cancelled = false;
    const done = (stopReason) => { prompts.delete(sessionId); send({ id, result: { stopReason } }); };
    prompts.set(sessionId, { id, cancel: () => { cancelled = true; done("cancelled"); } });
    if (/\bwait\b/.test(text)) return; // until session/cancel
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "sh-1", title: "touch /tmp/fake-acp-file", kind: "execute", status: "pending", rawInput: { command: "touch /tmp/fake-acp-file" } } } });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "sh-1", title: "touch /tmp/fake-acp-file", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (cancelled) return;
    const outcome = answer?.outcome?.outcome === "selected" ? answer.outcome.optionId : "cancelled";
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "sh-1", status: outcome === "allow-once" ? "completed" : "failed" } } });
    say(sessionId, `permission: ${outcome}`);
    return done("end_turn");
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `fake agent: no ${method}` } });
});
