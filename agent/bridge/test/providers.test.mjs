// Agent Provider adapters, tested by replaying recorded CLI output.
// Fixtures come from ASEPRITE_AGENT_RECORD + test/sanitize-recording.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toChatEvent } from "../dist/chat.js";
import { PROVIDERS, providerFor } from "../dist/providers/index.js";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

function replay(provider, name) {
  const parse = provider.parser();
  return fixture(name).flatMap((line) => parse(line));
}

// Checks shared by every provider's tool-using turn.
function checkToolTurn(events, providerId) {
  const conversations = events.filter((e) => e.type === "conversation");
  assert.equal(conversations.length, 1, "one conversation id per run");

  const tools = events.filter((e) => e.type === "tool");
  const results = events.filter((e) => e.type === "tool_result");
  assert.ok(tools.length >= 1, "at least one tool call");
  assert.equal(results.length, tools.length, "every tool call has a result");
  for (const t of tools) {
    assert.doesNotMatch(t.tool, /^mcp__/, "tool names have no MCP prefix");
    const r = results.find((x) => x.id === t.id);
    assert.ok(r, `result for ${t.id}`);
    assert.equal(r.tool, t.tool, "result names the same tool");
    assert.equal(r.ok, true);
  }
  assert.ok(tools.some((t) => t.tool === "execute_lua"), "the turn edits the sprite");

  const last = events.at(-1);
  assert.ok(events.some((e) => e.type === "text"), "a reply");
  assert.notEqual(last.type, "error");

  // The panel-facing mapping keeps ids and gives readable labels.
  const chat = events.map((e) => toChatEvent(e, providerId));
  assert.equal(chat[0].type, "session");
  for (const c of chat.filter((c) => c.type === "tool")) {
    assert.ok(c.tool && !c.tool.includes("mcp__"));
    assert.ok(c.kind === "edit" || c.kind === "read");
  }
  return { tools, results };
}

test("claude: tool-using turn", () => {
  const events = replay(PROVIDERS.claude, "claude-tool-turn.jsonl");
  checkToolTurn(events, "claude");
});

test("codex: tool-using turn", () => {
  const events = replay(PROVIDERS.codex, "codex-tool-turn.jsonl");
  checkToolTurn(events, "codex");
});

test("claude: errors and conversation changes", () => {
  const parse = PROVIDERS.claude.parser();
  assert.deepEqual(parse({ type: "system", subtype: "init", session_id: "a" }), [{ type: "conversation", id: "a" }]);
  assert.deepEqual(parse({ type: "system", subtype: "init", session_id: "a" }), [], "same id is reported once");
  assert.deepEqual(parse({ type: "result", is_error: true, result: "boom" }), [{ type: "error", text: "boom" }]);
  assert.deepEqual(parse({ type: "rate_limit_event" }), []);
});

test("codex: failed tool call and turn failure", () => {
  const parse = PROVIDERS.codex.parser();
  const [r] = parse({ type: "item.completed", item: { id: "x", type: "mcp_tool_call", tool: "snapshot", status: "failed", error: { message: "no sprite" } } });
  assert.deepEqual(r, { type: "tool_result", id: "x", tool: "snapshot", ok: false, content: "no sprite" });
  assert.deepEqual(parse({ type: "turn.failed", error: { message: "quota" } }), [{ type: "error", text: "quota" }]);
  assert.deepEqual(parse({ type: "item.completed", item: { type: "command_execution" } }), []);
});

test("commands: resume and MCP endpoint", () => {
  const req = { message: "hi", mcpUrl: "http://127.0.0.1:1/mcp", mcpToken: "t", systemPrompt: "s" };

  const claude = PROVIDERS.claude.command({ ...req, conversationId: "c1" });
  assert.equal(claude[claude.indexOf("--resume") + 1], "c1");
  const mcp = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]);
  assert.equal(mcp.mcpServers.aseprite.url, req.mcpUrl);
  assert.equal(claude[claude.indexOf("--tools") + 1], "", "no built-in tools");
  assert.ok(!PROVIDERS.claude.command(req).includes("--resume"));

  const codex = PROVIDERS.codex.command({ ...req, conversationId: "t1" });
  assert.deepEqual(codex.slice(-3), ["resume", "t1", "hi"]);
  assert.ok(codex.some((a) => a.includes('default_tools_approval_mode="approve"')));
  assert.equal(PROVIDERS.codex.command(req).at(-1), "hi");
});

test("providerFor defaults to claude", () => {
  assert.equal(providerFor("codex").id, "codex");
  assert.equal(providerFor(undefined).id, "claude");
  assert.equal(providerFor("unknown").id, "claude");
});

// The chat panel's Conversation test (agent/tests/conversation_test.lua)
// replays the chat events the bridge produces from these recordings.
// UPDATE_FIXTURES=1 npm test rewrites them after an intended change.
import { writeFileSync, existsSync } from "node:fs";

test("chat-event fixtures for the panel are current", () => {
  for (const id of ["claude", "codex"]) {
    const events = replay(PROVIDERS[id], `${id}-tool-turn.jsonl`).map((e) => toChatEvent(e, id));
    events.push({ type: "done" });
    const file = new URL(`../../tests/fixtures/chat-events-${id}.json`, import.meta.url);
    const json = JSON.stringify(events, null, 1) + "\n";
    if (process.env.UPDATE_FIXTURES || !existsSync(file)) writeFileSync(file, json);
    assert.equal(readFileSync(file, "utf8"), json, `${id}: run UPDATE_FIXTURES=1 npm test`);
  }
});

import { composeMessage } from "../dist/chat.js";

test("the state block goes first in every message", () => {
  const state = '<aseprite-state note="x">\nsprite: a 8x8 rgb, 1 frame\n</aseprite-state>';
  assert.equal(composeMessage({ prompt: "add a layer", state }), `${state}\n\nadd a layer`);
  assert.equal(composeMessage({ prompt: "add a layer", state: "" }), "add a layer");
  assert.equal(composeMessage({ prompt: "add a layer" }), "add a layer");
});
