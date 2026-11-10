// A critic (#76) through the provider runner spawn_agents uses, with the
// scripted ACP agent (test/helpers/fake_acp_agent.mjs): a fresh session on
// the critics' endpoint, the critic prompt, no built-in tools, and every ask
// in the same session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const agentScript = fileURLToPath(new URL("./helpers/fake_acp_agent.mjs", import.meta.url));
const logFile = join(mkdtempSync(join(tmpdir(), "fake-acp-critic-")), "log.jsonl");
process.env.ASEPRITE_AGENT_ACP_AGENT = agentScript;
process.env.FAKE_ACP_LOG = logFile;
const { SubAgents } = await import("../dist/subagents.js");
const { claudeProvider } = await import("../dist/providers/claude.js");
const { sessionDir } = await import("../dist/session.js");

test("a critic is a fresh ACP session on the critics' endpoint", async () => {
  mkdirSync(join(sessionDir, "workspace"), { recursive: true });
  const events = [];
  const agents = new SubAgents(
    { url: "http://127.0.0.1:1/mcp", askUrl: "http://127.0.0.1:1/mcp/ask", criticUrl: "http://127.0.0.1:1/mcp/critic", token: "tk" },
    async () => "", () => claudeProvider, (ev) => events.push(ev));
  const critic = agents.open("critic");
  try {
    // The fake agent asks for a shell command; critics refuse every permission.
    assert.equal(await critic.ask("first", [{ label: "s", mimeType: "image/png", data: "AA==" }]), "permission: cancelled");
    assert.equal(await critic.ask("second"), "permission: cancelled");
  } finally {
    critic.close();
  }
  const log = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const news = log.filter((m) => m.method === "session/new");
  assert.equal(news.length, 1, "the retry stays in the critic's session");
  assert.equal(news[0].params.mcpServers[0].url, "http://127.0.0.1:1/mcp/critic");
  assert.match(news[0].params._meta.systemPrompt.append, /pixel-art critic/);
  assert.deepEqual(news[0].params._meta.claudeCode.options.tools, [], "no built-in tools");
  const prompts = log.filter((m) => m.method === "session/prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.prompt[1].type, "image");
  assert.ok(events.some((e) => e.type === "status" && /critic started/.test(e.text)));
  assert.ok(!events.some((e) => e.type === "text"), "the critic's reply goes to the tool, not the chat");
});
