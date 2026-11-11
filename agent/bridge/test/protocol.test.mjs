// Contract tests: the bridge's code against the single protocol definition
// (agent/extension/protocol.json). The extension side has the same checks
// in agent/tests/batch_test.lua.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WebSocket } from "ws";
import { AsepriteLink } from "../dist/aseprite.js";
import { toChatEvent } from "../dist/chat.js";
import { bridgeMethods } from "../dist/bridge_methods.js";
import { base64Bytes, checkParams, packBinary, PROTOCOL } from "../dist/protocol.js";
import { documentOf } from "../dist/document.js";
import { resolveFrames } from "../dist/document.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";
import { PROVIDERS } from "../dist/providers/index.js";
import { findTool, runTool, TOOLS } from "../dist/tools.js";

test("every tool only uses protocol requests", async () => {
  const methods = new Set();
  const aseprite = {
    async request(method) {
      methods.add(method);
      if (method === "snapshot") return { result: { width: 1, height: 1, frame: 1, binary: true }, binary: Buffer.alloc(4) };
      if (method === "read_pixels") return { result: { x: 0, y: 0, width: 1, height: 1, frame: 1, keys: "color-key", legend: {}, rows: ["."] } };
      if (method === "run_command") return { result: { executed: true } };
      return { result: { ok: true } };
    },
  };
  const inputs = { execute_lua: { code: "return 1" }, run_command: { name: "CanvasSize" } };
  for (const tool of TOOLS) await runTool(tool, inputs[tool.name] ?? {}, aseprite);
  for (const m of methods) assert.ok(Object.hasOwn(PROTOCOL.requests, m), `${m} is in protocol.json`);
  for (const t of TOOLS.filter((t) => !t.run)) assert.ok(methods.has(t.name), `${t.name} forwards to its request`);
  assert.equal(PROTOCOL.requests.snapshot.binary, true);
});

test("the bridge answers exactly the protocol's bridge methods", () => {
  const fakeChat = { providers: () => ({}), busy: false, send() {}, stop() {}, reset() {} };
  assert.deepEqual(Object.keys(bridgeMethods(fakeChat, "0")).sort(), Object.keys(PROTOCOL.bridgeMethods).sort());
});

test("chat events use only protocol types and fields", () => {
  const { types, fields } = PROTOCOL.notifications["chat.event"];
  for (const id of ["claude", "codex"]) {
    const parse = PROVIDERS[id].parser();
    const lines = readFileSync(new URL(`./fixtures/${id}-tool-turn.jsonl`, import.meta.url), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      for (const ev of parse(JSON.parse(line)).map((e) => toChatEvent(e, id))) {
        assert.ok(types.includes(ev.type), `type ${ev.type}`);
        for (const k of Object.keys(ev)) assert.ok(fields.includes(k), `field ${k}`);
      }
    }
  }
});

/** Connects like the extension does and returns the first message and the close code. */
async function hello(link, port, protocol) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol, asepriteVersion: "test" } }));
  const code = await Promise.race([
    new Promise((r) => ws.once("close", (c) => r(c))),
    new Promise((r) => setTimeout(() => r("open"), 300)),
  ]);
  ws.close();
  return { first: messages[0], code };
}

test("hello: matching version is welcomed, other versions are told why", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  try {
    const ok = await hello(link, port, PROTOCOL.version);
    assert.equal(ok.first.method, "welcome");
    assert.equal(ok.code, "open");

    const old = await hello(link, port, PROTOCOL.version - 1);
    assert.equal(old.first.method, "incompatible");
    assert.match(old.first.params.message, /Update the extension/);
    assert.equal(old.code, 4004);
  } finally {
    link.stop();
  }
});

test("a second Aseprite takes the bridge; the first is told 'replaced' before it closes", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol: PROTOCOL.version, asepriteVersion: "test" } }));
    await new Promise((r) => setTimeout(r, 100));
    return { ws, messages };
  };
  try {
    const a = await open();
    const closed = new Promise((r) => a.ws.once("close", (c) => r(c)));
    const b = await open();
    assert.equal(await closed, 4000);
    assert.deepEqual(a.messages.map((m) => m.method), ["welcome", "replaced"]);
    assert.deepEqual(b.messages.map((m) => m.method), ["welcome"]);
    assert.ok(PROTOCOL.handshake?.replaced ?? JSON.stringify(PROTOCOL).includes('"replaced"'), "replaced is in protocol.json");
    b.ws.close();
  } finally {
    link.stop();
  }
});

test("requests outside the protocol are refused before sending", async () => {
  const link = new AsepriteLink();
  await assert.rejects(link.request("format_disk"), /Not a protocol request/);
});

test("frame specs follow protocol.json's grammar (the extension runs the same examples)", () => {
  for (const ex of PROTOCOL.params.frameSpecExamples) {
    const run = () => resolveFrames(ex.spec ?? undefined, ex.count, ex.active, ex.default ?? "active");
    if (ex.error) assert.throws(run, new RegExp(ex.error), JSON.stringify(ex));
    else assert.deepEqual(run(), ex.frames, JSON.stringify(ex));
  }
});

test("every request has a params schema; tools that forward their input match it", () => {
  for (const [name, r] of Object.entries(PROTOCOL.requests)) assert.ok(r.params, `${name} has params`);
  for (const t of TOOLS.filter((t) => !t.run && Object.hasOwn(PROTOCOL.requests, t.name))) {
    const schema = PROTOCOL.requests[t.name].params;
    for (const key of Object.keys(t.input.shape)) assert.ok(key in schema, `${t.name}: input '${key}' is in protocol.json`);
  }
});

test("every request has a kind; tools that forward to a request agree with it", () => {
  const kinds = ["read", "write", "scoped-write"];
  for (const [name, r] of Object.entries(PROTOCOL.requests)) {
    assert.ok(kinds.includes(r.kind), `${name} has a kind (${r.kind})`);
    if (r.needsSprite !== undefined) assert.equal(typeof r.needsSprite, "boolean", `${name}: needsSprite`);
  }
  // A tool named after its request is an edit exactly when the request writes.
  const named = TOOLS.filter((t) => Object.hasOwn(PROTOCOL.requests, t.name));
  assert.ok(named.length > 5);
  for (const t of named) {
    assert.equal(t.kind === "edit", PROTOCOL.requests[t.name].kind !== "read", `${t.name}: tool kind ${t.kind}, request kind ${PROTOCOL.requests[t.name].kind}`);
  }
  // Undo and redo could undo another agent's work: never allowed in a scope.
  assert.equal(PROTOCOL.requests.undo.kind, "write");
  assert.equal(PROTOCOL.requests.redo.kind, "write");
});

test("checkParams: unknown, missing and mistyped params", () => {
  assert.throws(() => checkParams("snapshot", { bogus: 1 }), /unknown param 'bogus'/);
  assert.throws(() => checkParams("set_slice", { x: 0, y: 0, w: 1, h: 1 }), /'name' is required/);
  assert.throws(() => checkParams("undo", { steps: "2" }), /'steps' must be an integer/);
  checkParams("snapshot", { layer: "L3", frame: 2, scope: {} });
  checkParams("put_image", { width: 1, height: 1, rgba: "AAAA", frame: undefined });
});

test("every request a skill tool sends passes the schema", async () => {
  const sent = [];
  const base = fakeDocument({ width: 8, height: 8, frames: 2, layers: [{ name: "Body", frames: [rect(8, 8, [1, 1, 6, 6], [60, 170, 80]), rect(8, 8, [2, 1, 6, 6], [60, 170, 80])] }] });
  const aseprite = {
    async request(method, params = {}) {
      sent.push([method, params]);
      if (["get_state", "snapshot", "put_image", "create_sprite", "create_animation"].includes(method)) return base.request(method, params);
      return { result: { ok: true, colors: [], palette: [], layers: [], title: "x" } };
    },
  };
  // Each tool with the inputs the MCP layer would accept (others need real arguments).
  for (const tool of TOOLS.filter((t) => t.run)) {
    const input = tool.input.safeParse({ layer: "Body" }).success ? { layer: "Body" } : tool.input.safeParse({}).success ? {} : undefined;
    if (input) await runTool(tool, input, aseprite);
  }
  assert.ok(sent.length > 20);
  for (const [method, params] of sent) assert.doesNotThrow(() => checkParams(method, params), `${method} ${JSON.stringify(params).slice(0, 120)}`);
});

// #95: pixel bytes go as one binary frame after the request (protocol.json binaryRequests).
test("packBinary: raw bytes become {offset, length} into one blob; base64Bytes for JSON lines", () => {
  const a = new Uint8Array([1, 2, 3, 4]), b = Buffer.from([5, 6, 7, 8, 9, 10, 11, 12]);
  const params = { images: [{ rgba: a, frame: 1 }, { rgba: b, frame: 2 }], label: "x" };
  const { params: packed, blob } = packBinary(params);
  assert.deepEqual(packed, { images: [{ rgba: { offset: 0, length: 4 }, frame: 1 }, { rgba: { offset: 4, length: 8 }, frame: 2 }], label: "x" });
  assert.deepEqual([...blob], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(params.images[0].rgba instanceof Uint8Array, "the input is left as is");
  assert.deepEqual(packBinary({ label: "x" }), { params: { label: "x" } });
  const sub = new Uint8Array(new Uint8Array([0, 9, 9, 0]).buffer, 1, 2);
  assert.deepEqual(base64Bytes({ images: [{ rgba: sub }] }), { images: [{ rgba: Buffer.from([9, 9]).toString("base64") }] });
  checkParams("put_image", { width: 1, height: 1, rgba: new Uint8Array(4) });
  assert.throws(() => checkParams("put_image", { width: 1, height: 1, rgba: [1, 2] }), /'rgba' must be a bytes/);
});

test("AsepriteLink sends pixel bytes as one binary frame after the request", async () => {
  const link = new AsepriteLink();
  const port = await link.start(0, { publish: false });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.on("message", (d, isBinary) => got.push(isBinary ? { frame: Buffer.from(d) } : JSON.parse(d.toString())));
  const until = async (fn) => { while (!fn()) await new Promise((r) => setTimeout(r, 10)); };
  try {
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { token: link.token, protocol: PROTOCOL.version, asepriteVersion: "test" } }));
    assert.ok(await link.waitForConnection(2000));
    const img = { width: 1, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
    const done = documentOf(link).putImages([{ image: img, frame: 1, newLayer: "a" }, { image: img, frame: 2, newLayer: "a" }]);
    await until(() => got.some((m) => m.frame));
    const i = got.findIndex((m) => m.method === "put_images");
    const req = got[i];
    assert.equal(req.binary, 16);
    assert.deepEqual(req.params.images.map((im) => im.rgba), [{ offset: 0, length: 8 }, { offset: 8, length: 8 }]);
    assert.deepEqual([...got[i + 1].frame], [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { layers: [], frames: 2, added: 0 } }));
    assert.equal((await done).frames, 2);
    // A request without bytes has no binary field and no frame.
    const state = link.request("get_state", {});
    await until(() => got.some((m) => m.method === "get_state"));
    const g = got.find((m) => m.method === "get_state");
    assert.equal(g.binary, undefined);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: g.id, result: { asepriteVersion: "t", apiVersion: 1, openSprites: [], fgColor: "#000000", bgColor: "#000000" } }));
    await state;
    assert.equal(got.filter((m) => m.frame).length, 1);
  } finally {
    ws.close();
    link.stop();
  }
});

test("the fake document takes raw bytes, as the Document sends them", async () => {
  const doc = fakeDocument({ width: 2, height: 1 });
  const img = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
  await documentOf(doc).putImages([{ image: img, frame: 1, newLayer: "raw" }]);
  const back = await documentOf(doc).pixels("AI: raw", 1);
  assert.deepEqual([...back.data], [...img.data]);
});
