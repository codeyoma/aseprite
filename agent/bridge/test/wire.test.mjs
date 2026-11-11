// The wire seam (#96): each side checks what it receives, once. The bridge
// checks bridge-method params (protocol.json bridgeMethods) and typed results
// (get_state: State) on arrival; the extension checks request params
// (wire_params.lua), so the bridge sends them as given. The contract
// scenarios (agent/tests/contract/wire.json) hold the Lua side to the same rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { AsepriteLink } from "../dist/aseprite.js";
import { bridgeMethods } from "../dist/bridge_methods.js";
import { checkBridgeParams, checkShape, parseType, PROTOCOL, shapeFields } from "../dist/protocol.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

test("protocol.json: every bridge method, shape and typed result uses known types", () => {
  for (const m of Object.values(PROTOCOL.bridgeMethods)) for (const t of Object.values(m.params)) parseType(t);
  for (const name of Object.keys(PROTOCOL.shapes)) for (const t of Object.values(shapeFields(name))) parseType(t);
  for (const r of Object.values(PROTOCOL.requests)) if (r.result) parseType(r.result);
  assert.deepEqual(parseType("integer[][]?"), { base: "integer", wrap: ["[]", "[]"], optional: true, fallback: undefined });
  assert.deepEqual(parseType("frames?all"), { base: "frames", wrap: [], optional: true, fallback: "all" });
  assert.throws(() => parseType("Nope"), /unknown type 'Nope'/);
  assert.throws(() => parseType("string["), /malformed type/);
  assert.equal(PROTOCOL.requests.get_context, undefined, "get_context is a view of get_state since protocol 41");
});

test("checkBridgeParams: errors name the method and the param path", () => {
  checkBridgeParams("chat.send", { prompt: "hi", sessions: [], attachments: [{ label: "a", path: "/a.png" }], memory: {} });
  checkBridgeParams("chat.info", []);
  checkBridgeParams("chat.permission", { requestId: "perm-1", optionId: null });
  assert.throws(() => checkBridgeParams("chat.send", { prompt: "hi", attachments: [{ label: "a", path: 1 }] }),
    /^Error: chat\.send: 'attachments\[0\]\.path' must be a string$/);
  assert.throws(() => checkBridgeParams("chat.send", { prompt: "hi", attachments: [1] }), /'attachments\[0\]' must be an object \(Attachment\)/);
  assert.throws(() => checkBridgeParams("chat.stop", { chatId: "c1", scope: {} }), /chat\.stop: unknown param 'scope'/);
  assert.throws(() => checkBridgeParams("chat.send", "hi"), /chat\.send: params must be an object/);
  assert.throws(() => checkBridgeParams("nope", {}), /Not a bridge method/);
});

test("checkShape: get_state's State, strict, with paths", async () => {
  const st = (await fakeDocument({ width: 2, height: 2, layers: [{ name: "Body", frames: [rect(2, 2, [0, 0, 0, 0], [1, 2, 3])] }] }).request("get_state")).result;
  checkShape("State", st);
  checkShape("State", { asepriteVersion: "1", apiVersion: 1, openSprites: [], fgColor: "#000000", bgColor: "#000000" });
  const bad = structuredClone(st);
  bad.activeSprite.layers[0].opacity = "full";
  assert.throws(() => checkShape("State", bad, "get_state result"), /get_state result: 'result\.activeSprite\.layers\[0\]\.opacity' must be an integer/);
  const extra = structuredClone(st);
  extra.activeSprite.layers[0].shiny = true;
  assert.throws(() => checkShape("State", extra), /unknown param 'result\.activeSprite\.layers\[0\]\.shiny'/);
});

/** An extension on a WebSocket: hello, then the bridge's requests answered by answer(msg). */
async function extension(link, port, answer = () => undefined) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    got.push(msg);
    if (typeof msg.id === "number" && msg.method) {
      const result = answer(msg);
      if (result !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    }
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol: PROTOCOL.version, asepriteVersion: "test" } }));
  assert.ok(await link.waitForConnection(2000));
  const call = async (id, method, params) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    while (!got.some((m) => m.id === id)) await new Promise((r) => setTimeout(r, 5));
    return got.find((m) => m.id === id);
  };
  return { ws, call };
}

test("AsepriteLink checks a bridge method's params before its handler runs", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const seen = [];
  for (const [m, h] of Object.entries(bridgeMethods({ providers: () => ({}), busy: false, send() {}, stop() {}, reset() {} }, "0"))) {
    link.onRequest(m, (p) => { seen.push(m); return h(p); });
  }
  const { ws, call } = await extension(link, port);
  try {
    const bad = await call("x1", "chat.send", { prompt: "hi", attachments: [{ label: "a" }] });
    assert.equal(bad.error.message, "chat.send: 'attachments[0].path' is required");
    assert.deepEqual(seen, [], "the handler did not run");
    const ok = await call("x2", "chat.info", []);
    assert.equal(ok.result.version, "0");
    const unknown = await call("x3", "skills.list", { bogus: 1 });
    assert.match(unknown.error.message, /skills\.list: unknown param 'bogus'/);
  } finally {
    ws.close();
    link.stop();
  }
});

test("AsepriteLink sends request params as given (the extension checks them) and checks get_state's result", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const fake = fakeDocument({ width: 2, height: 2 });
  let reply;
  const { ws } = await extension(link, port, (msg) => (msg.method === "get_state" ? reply : { echoed: msg.params }));
  try {
    // No bridge-side params check: wire_params.lua answers a bad param with its error.
    assert.deepEqual((await link.request("undo", { steps: "two" })).result, { echoed: { steps: "two" } });
    reply = (await fake.request("get_state")).result;
    assert.equal((await link.request("get_state")).result.activeSprite.width, 2);
    reply = { ...reply, activeSprite: { ...reply.activeSprite, width: "2" } };
    await assert.rejects(link.request("get_state"), /get_state result: 'result\.activeSprite\.width' must be an integer/);
  } finally {
    ws.close();
    link.stop();
  }
});

test("get_context is a view of get_state: the active layer's path, the cel and range by path, the selection", async () => {
  const fake = fakeDocument({ width: 4, height: 2, layers: [{ name: "Body", frames: [rect(4, 2, [0, 0, 1, 1], [255, 0, 0])] }] });
  const state = (await fake.request("get_state")).result;
  const id = state.activeLayerId;
  const reply = {
    ...state, tool: "pencil", activeTag: "walk",
    activeCel: { layer: id, frame: 1, bounds: { x: 0, y: 0, width: 2, height: 2 }, opacity: 255 },
    timelineRange: { type: "cels", layers: [id], frames: [1] },
    activeSprite: { ...state.activeSprite, selection: { x: 0, y: 0, width: 1, height: 1 } },
  };
  checkShape("State", reply);
  const calls = [];
  const res = await runTool(findTool("get_context"), {}, { request: async (m) => { calls.push(m); return { result: reply }; } });
  assert.deepEqual(calls, ["get_state"]);
  const ctx = JSON.parse(res.content[0].text);
  assert.equal(ctx.sprite.width, 4);
  assert.deepEqual(ctx.layer, { id, name: "Body", path: "Body", group: false, visible: true, editable: true, opacity: 255 });
  assert.equal(ctx.frame, 1);
  assert.equal(ctx.tag, "walk");
  assert.equal(ctx.cel.layer, "Body");
  assert.deepEqual(ctx.timelineRange, { type: "cels", layers: ["Body"], layerIds: [id], frames: [1] });
  assert.deepEqual(ctx.selection, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(ctx.tool, "pencil");
  const none = await runTool(findTool("get_context"), {}, { request: async () => ({ result: { tool: "pencil", fgColor: "#000000", bgColor: "#ffffff" } }) });
  assert.equal(JSON.parse(none.content[0].text).sprite, null);
});
