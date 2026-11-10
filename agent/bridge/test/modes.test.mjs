// Chat modes (#24): Ask and Plan runs use the read-only MCP endpoint, which
// lists only read tools and refuses edit tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpEndpoint } from "../dist/http.js";
import { composeMessage, chatMode } from "../dist/chat.js";
import { TOOLS } from "../dist/tools.js";

async function connect(url, token) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

test("the ask endpoint lists only read tools and refuses edits", async () => {
  const calls = [];
  const link = { request: async (method, params) => { calls.push(method); return { result: { ok: true } }; } };
  const ep = await startHttpEndpoint(link, "t0k");
  try {
    const full = await connect(ep.url, "t0k");
    const ask = await connect(ep.askUrl, "t0k");
    const fullNames = (await full.listTools()).tools.map((t) => t.name);
    const askNames = (await ask.listTools()).tools.map((t) => t.name);
    assert.ok(fullNames.includes("execute_lua"));
    assert.deepEqual(askNames.sort(), TOOLS.filter((t) => t.kind === "read").map((t) => t.name).sort());
    const forced = await ask.callTool({ name: "execute_lua", arguments: { code: "app.sprite:resize(1,1)" } }).catch((e) => ({ isError: true, error: e }));
    assert.ok(forced.isError, "edit tool refused");
    assert.ok(!calls.includes("execute_lua"), "never reached Aseprite");
    await full.close();
    await ask.close();
  } finally {
    ep.server.close();
  }
});

test("mode notes go with the message", () => {
  assert.equal(composeMessage({ prompt: "hi", state: "<s/>" }), "<s/>\n\nhi");
  assert.match(composeMessage({ prompt: "hi", state: "<s/>", mode: "ask" }), /^<mode>Ask:.*<\/mode>\n<s\/>\n\nhi$/s);
  assert.match(composeMessage({ prompt: "hi", state: "", mode: "plan" }), /^<mode>Plan:.*numbered plan.*<\/mode>\n\nhi$/s);
  assert.equal(chatMode("plan"), "plan");
  assert.equal(chatMode("bogus"), "agent");
  assert.equal(chatMode(undefined), "agent");
});
