// Lean agent sessions (#87): only the aseprite MCP server and the user's model choice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCodexHome, leanCodexConfig, LEAN_CLAUDE_OPTIONS } from "../dist/providers/agent_home.js";
import { claudeProvider } from "../dist/providers/claude.js";

const USER = `notify = ["/x/Notify.app", "turn-ended"]
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
service_tier = "priority"

[mcp_servers.context7]
command = "npx"
[plugins."visualize@openai-bundled"]
enabled = true
model = "not-top-level"
`;

test("the Codex config keeps the model settings and nothing else", () => {
  assert.equal(leanCodexConfig(USER, undefined), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\nservice_tier = "priority"\n');
  assert.equal(leanCodexConfig(USER, "medium"), 'model = "gpt-6.1-sol"\nservice_tier = "priority"\nmodel_reasoning_effort = "medium"\n');
});

test("the Codex home links the user's auth and writes the lean config", () => {
  const user = mkdtempSync(join(tmpdir(), "codex-user-")), home = mkdtempSync(join(tmpdir(), "codex-agent-"));
  writeFileSync(join(user, "auth.json"), "{}");
  writeFileSync(join(user, "config.toml"), USER);
  assert.equal(agentCodexHome(user, home), home);
  assert.equal(readlinkSync(join(home, "auth.json")), join(user, "auth.json"));
  assert.doesNotMatch(readFileSync(join(home, "config.toml"), "utf8"), /mcp_servers|plugins|notify/);
  agentCodexHome(user, home); // again: the link is replaced, not duplicated
});

test("Claude sessions load no settings files and only the given MCP servers", () => {
  for (const mode of ["agent", "ask", "developer"]) {
    const o = claudeProvider.acp.sessionMeta("x", mode).claudeCode.options;
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  }
  assert.deepEqual(LEAN_CLAUDE_OPTIONS.settingSources, []);
});
