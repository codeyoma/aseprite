// Contract tests: the bridge's code against the single protocol definition
// (agent/extension/protocol.json). The extension side has the same checks
// in agent/tests/batch_test.lua.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WebSocket } from "ws";
import { AsepriteLink } from "../dist/aseprite.js";
import { chatMethods, toChatEvent } from "../dist/chat.js";
import { PROTOCOL } from "../dist/protocol.js";
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
  assert.deepEqual(Object.keys(chatMethods(fakeChat, "0")).sort(), [...PROTOCOL.bridgeMethods].sort());
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

test("requests outside the protocol are refused before sending", async () => {
  const link = new AsepriteLink();
  await assert.rejects(link.request("format_disk"), /Not a protocol request/);
});
