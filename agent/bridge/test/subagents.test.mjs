// Parallel sub-agents (#33): scheduling, scope tagging, results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpEndpoint } from "../dist/http.js";
import { formatSubResults, pool, scopeLabel, SubAgents } from "../dist/subagents.js";

test("pool runs at most `limit` at once and keeps the order", async () => {
  let running = 0, peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7, 8], 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return n * 10;
  });
  assert.equal(peak, 4);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80]);
});

test("labels and the lead agent's summary", () => {
  assert.equal(scopeLabel({ prompt: "", frames: "1-2" }), "frames 1-2");
  assert.equal(scopeLabel({ prompt: "", frames: [3, 4], layers: ["L2"] }), "frames 3,4 · L2");
  assert.equal(formatSubResults([
    { label: "frames 1-2", ok: true, text: "Shaded.", seconds: 30 },
    { label: "frames 3-4", ok: false, text: "Failed: x", seconds: 12 },
  ], 31), "1 of 2 sub-agents finished in 31s (run in parallel).\n- frames 1-2 (30s): Shaded.\n- frames 3-4 (12s) FAILED: Failed: x\nCheck the result with snapshot, and fix anything a sub-agent missed.");
});

test("a sub-agent's endpoint tags every request with its scope and has no spawn_agents", async () => {
  const calls = [];
  const link = { request: async (method, params) => { calls.push({ method, params }); return { result: { ok: true, value: 1, output: [] } }; } };
  const ep = await startHttpEndpoint(link, "tk");
  // Register a scope the way SubAgents does: start a run whose agent never connects.
  const { scopeFor } = await import("../dist/subagents.js");
  try {
    const scoped = new SubAgents(ep, async () => "<aseprite-state/>", () => ({ id: "claude", acp: undefined }), () => {});
    // Without an installed ACP agent the run fails fast, but the scope must not leak.
    const [r] = await scoped.run([{ prompt: "x", frames: "1-2" }]);
    assert.equal(r.ok, false);

    const res = await fetch(`${ep.url}/scope/abc123`, { method: "POST", headers: { Authorization: "Bearer tk" } });
    assert.equal(res.status, 404, "unknown scopes are refused");

    // A registered scope (white-box: through the module's registry).
    const mod = await import("../dist/subagents.js");
    const id = "deadbeef";
    mod.__setScopeForTest?.(id, { frames: "1-2", label: "frames 1-2" });
    if (scopeFor(id)) {
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ep.url}/scope/${id}`), { requestInit: { headers: { Authorization: "Bearer tk" } } }));
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("execute_lua") && !names.includes("spawn_agents"));
      await client.callTool({ name: "execute_lua", arguments: { code: "return 1" } });
      assert.deepEqual(calls.at(-1).params.scope, { frames: "1-2", label: "frames 1-2" });
      await client.close();
    } else {
      assert.fail("scope registry test hook missing");
    }
  } finally {
    ep.server.close();
  }
});
