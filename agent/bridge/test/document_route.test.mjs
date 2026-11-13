// Document-scoped requests (#90): a request names the sprite it acts on with
// doc in the JSON-RPC envelope (protocol.json routing). The bridge sends the
// doc a caller gives through every requester (tool context, the chat's HTTP
// endpoint, AsepriteLink, HeadlessLink); the extension resolves it
// (agent/tests/document_scope_test.lua). With ASEPRITE set, the headless
// runner writes to the named sprite while another is active.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AsepriteLink } from "../dist/aseprite.js";
import { encodeRequest, HeadlessLink } from "../dist/headless.js";
import { startHttpEndpoint } from "../dist/http.js";
import { contextOf, documentOf, parseState } from "../dist/document.js";
import { PROTOCOL } from "../dist/protocol.js";
import { toolContext, withDoc } from "../dist/tool.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const ASEPRITE = process.env.ASEPRITE;
const extensionDir = fileURLToPath(new URL("../../extension", import.meta.url));

test("protocol 45: snapshot leaves layers out; apply's ops in applyOps (#116)", () => {
  assert.equal(PROTOCOL.version, 45);
  assert.equal(PROTOCOL.requests.snapshot.params.exclude, "array?");
  assert.equal(PROTOCOL.applyOps.rect.color, "any");
});

test("protocol 44: snapshot reads several frames in one reply (#114)", () => {
  assert.equal(PROTOCOL.requests.snapshot.params.frames, "array?");
});

test("protocol 43: the motion store travels in put_images and get_state (#109)", () => {
  assert.equal(PROTOCOL.requests.put_images.params.motion, "string?");
  assert.equal(PROTOCOL.shapes.Sprite.motion, "string?");
});

test("protocol 42: SpriteSummary has an id; activates marks the requests that run in the foreground", () => {
  assert.equal(PROTOCOL.shapes.SpriteSummary.id, "string");
  const activates = Object.entries(PROTOCOL.requests).filter(([, r]) => r.activates).map(([n]) => n).sort();
  assert.deepEqual(activates, ["apply_timeline_text", "execute_lua", "run_command"]);
  assert.match(PROTOCOL.routing, /doc/);
});

test("get_state's sprite id reaches SpriteInfo and the context view", async () => {
  const fake = fakeDocument({ width: 2, height: 2, layers: [{ name: "Body", frames: [rect(2, 2, [0, 0, 0, 0], [1, 2, 3])] }] });
  const state = (await fake.request("get_state")).result;
  assert.equal(state.activeSprite.id, "S1");
  assert.equal(parseState(state).doc, "S1");
  assert.equal(contextOf(state).sprite.id, "S1");
});

test("toolContext keeps the route; withDoc names the sprite on every request", async () => {
  const calls = [];
  const link = { request: async (method, params, timeoutMs, route) => { calls.push({ method, route }); return { result: {} }; } };
  const ctx = toolContext(link);
  await ctx.request("get_state", {}, 1000, { origin: "chat", chat: "c1", doc: "S4" });
  assert.deepEqual(calls.at(-1).route, { origin: "chat", chat: "c1", doc: "S4" });
  const bound = withDoc(ctx, "S7");
  await bound.request("snapshot", {});
  assert.deepEqual(calls.at(-1).route, { doc: "S7" });
  await bound.request("snapshot", {}, 1000, { origin: "chat", chat: "c2" });
  assert.deepEqual(calls.at(-1).route, { origin: "chat", chat: "c2", doc: "S7" });
  assert.equal(withDoc(ctx, undefined), ctx, "no doc: the requester as it is");
  // A Document over a bound requester sends the doc with each request it makes.
  await documentOf(withDoc(link, "S9")).infoOrNone().catch(() => undefined);
  assert.deepEqual(calls.at(-1), { method: "get_state", route: { doc: "S9" } });
});

test("AsepriteLink sends doc in the envelope, next to origin and chat, not in the params", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (typeof msg.id === "number" && msg.method) {
      got.push(msg);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
    }
  });
  try {
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol: PROTOCOL.version, asepriteVersion: "test" } }));
    assert.ok(await link.waitForConnection(2000));
    await link.request("write_pixels", { rows: ["r"], legend: { r: "#ff0000" } }, 2000, { origin: "chat", chat: "c1", doc: "S3" });
    assert.equal(got.at(-1).doc, "S3");
    assert.equal(got.at(-1).chat, "c1");
    assert.equal(got.at(-1).params.doc, undefined);
    await link.request("ping", {}, 2000);
    assert.equal("doc" in got.at(-1), false, "no route, no doc");
  } finally {
    ws.close();
    link.stop();
  }
});

test("the chat's HTTP endpoint sends ?doc= with every request, next to ?chat=", async () => {
  const calls = [];
  const link = { request: async (method, params, timeoutMs, route) => { calls.push({ method, route }); return { result: { ok: true, value: 1, output: [] } }; } };
  const ep = await startHttpEndpoint(link, "tk");
  try {
    for (const [query, want] of [["?chat=c1&doc=S5", { origin: "chat", chat: "c1", doc: "S5" }], ["?chat=c2", { origin: "chat", chat: "c2" }]]) {
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ep.url}${query}`), { requestInit: { headers: { Authorization: "Bearer tk" } } }));
      await client.callTool({ name: "execute_lua", arguments: { code: "return 1" } });
      await client.close();
      assert.deepEqual(calls.at(-1).route, want, query);
    }
  } finally {
    ep.server.close();
  }
});

test("HeadlessLink puts doc on the request line", () => {
  assert.equal(encodeRequest({ id: 1, method: "snapshot", params: {}, doc: "S2" }), '{"id":1,"method":"snapshot","params":{},"doc":"S2"}\n');
});

test("the headless runner acts on the sprite a request names", { skip: !ASEPRITE && "set ASEPRITE to run" }, async () => {
  const link = new HeadlessLink({ bin: ASEPRITE, extensionDir, liveFiles: async () => [] });
  try {
    await link.start();
    await link.request("create_sprite", { width: 2, height: 2, rgba: Buffer.alloc(16).toString("base64"), title: "first" });
    await link.request("create_sprite", { width: 3, height: 3, rgba: Buffer.alloc(36).toString("base64"), title: "second" });
    const state = (await link.request("get_state", {})).result;
    assert.equal(state.activeSprite.filename, "second");
    const first = state.openSprites.find((s) => s.filename === "first");
    assert.match(first.id, /^S\d+$/);
    await link.request("write_pixels", { rows: ["r ."], legend: { r: "#ff0000" } }, 10_000, { doc: first.id });
    const routed = (await link.request("get_state", {}, 10_000, { doc: first.id })).result;
    assert.equal(routed.activeSprite.filename, "first");
    assert.equal((await link.request("get_state", {})).result.activeSprite.filename, "second", "the active sprite stays");
    const snap = await link.request("snapshot", {}, 10_000, { doc: first.id });
    assert.equal(snap.binary.length, 2 * 2 * 4);
    assert.deepEqual([...snap.binary.subarray(0, 4)], [255, 0, 0, 255]);
    await assert.rejects(link.request("snapshot", {}, 10_000, { doc: "S999999" }), /Sprite not found/);
  } finally {
    await link.stop();
  }
});
