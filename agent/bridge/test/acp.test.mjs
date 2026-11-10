// ACP mapper: replays sanitized session/update recordings from both ACP
// agents (test/sanitize-acp.mjs) and checks the events the chat panel gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AcpMapper, normalizeTool } from "../dist/providers/acp_mapper.js";

function replay(name) {
  const m = new AcpMapper();
  const events = [];
  for (const line of readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split("\n")) {
    events.push(...m.map(JSON.parse(line)));
  }
  return [...events, ...m.flush()];
}

const steps = (events) => events.filter((e) => e.type === "tool_result").map((e) => `${e.tool}:${e.ok}`);

test("claude-agent-acp turn maps to bridge tools", () => {
  const ev = replay("acp-claude-tool-turn.jsonl");
  assert.deepEqual(steps(ev), ["get_state:true", "execute_lua:true"]);
  // A step refined as its input streams in keeps its id.
  const lua = ev.filter((e) => e.type === "tool" && e.tool === "execute_lua");
  assert.ok(lua.length >= 2 && new Set(lua.map((e) => e.id)).size === 1);
  assert.ok(lua.at(-1).input.code, "latest input has the Lua code");
  assert.equal(ev.at(-1).type, "text");
  assert.equal(ev.filter((e) => e.type === "text").length, 1, "message chunks merged");
});

test("codex-acp turn maps to bridge tools and hides guardian reviews", () => {
  const ev = replay("acp-codex-tool-turn.jsonl");
  assert.deepEqual(steps(ev).filter((s) => !s.startsWith("Read file")), [
    "get_state:true",
    "read_guide:true",
    "get_context:true",
    "execute_lua:true",
  ]);
  assert.ok(!ev.some((e) => String(e.tool ?? "").includes("Guardian")));
  const own = ev.find((e) => e.type === "tool" && e.tool.startsWith("Read file"));
  assert.equal(own.kind, "read", "the agent's own tools keep their ACP kind");
  assert.ok(ev.some((e) => e.type === "thinking"));
  assert.equal(ev.at(-1).type, "text");
});

test("plan updates become plan events", () => {
  const m = new AcpMapper();
  const ev = m.map({ sessionUpdate: "plan", entries: [{ content: "Add layer", status: "completed", priority: "high" }, { content: "Draw", status: "in_progress" }] });
  assert.deepEqual(ev, [{ type: "plan", entries: [{ content: "Add layer", status: "completed" }, { content: "Draw", status: "in_progress" }] }]);
});

test("normalizeTool names", () => {
  assert.equal(normalizeTool({ title: "mcp__aseprite__check" }).tool, "check");
  assert.equal(normalizeTool({ title: "mcp.aseprite.check" }).tool, "check");
  assert.deepEqual(normalizeTool({ rawInput: { server: "aseprite", tool: "get_state", arguments: { a: 1 } } }).input, { a: 1 });
  const shell = normalizeTool({ title: "Run ls", kind: "execute" });
  assert.equal(shell.kind, "edit");
  assert.ok(normalizeTool({ toolCallId: "guardian_assessment_1", title: "x" }).hidden);
});

// Permission round trip: the agent's request reaches the panel as a chat
// event, and the panel's chat.permission answer resolves it.
test("permission requests go to the panel and back", async () => {
  const { ChatRunner, chatMethods } = await import("../dist/chat.js");
  const sent = [];
  const chat = new ChatRunner({ notify: (method, params) => sent.push({ method, params }) }, { url: "", token: "" });
  const methods = chatMethods(chat, "test");
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];

  const answered = chat["askPermission"]({ title: "Run ls", options });
  const ev = sent.at(-1).params;
  assert.equal(ev.type, "permission");
  assert.equal(ev.text, "Run ls");
  methods["chat.permission"]({ requestId: ev.requestId, optionId: "allow" });
  assert.deepEqual(await answered, { outcome: "selected", optionId: "allow" });

  // An unknown option is a rejection.
  const rejected = chat["askPermission"]({ title: "Run rm", options });
  methods["chat.permission"]({ requestId: sent.at(-1).params.requestId, optionId: "bogus" });
  assert.deepEqual(await rejected, { outcome: "selected", optionId: "deny" });
});
