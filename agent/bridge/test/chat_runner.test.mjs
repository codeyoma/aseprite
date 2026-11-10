// ChatRunner over the runtime seam (#55), with a fake runtime and link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatRunner, chatMethods, composeMessage } from "../dist/chat.js";
import { PROVIDERS } from "../dist/providers/index.js";

/** A runtime whose turns the test ends by hand. */
function fakeRuntime(name = "acp") {
  const turns = [];
  return {
    name, turns, stops: 0,
    supports: () => true,
    start(turn, sink) {
      return new Promise((resolve, reject) => turns.push({ turn, sink, resolve, reject }));
    },
    stop() { this.stops++; const t = turns.at(-1); t?.resolve({ conversationId: t.turn.conversationId, stop: "cancelled" }); },
    dispose() {},
  };
}
function setup(runtime = fakeRuntime()) {
  const events = [];
  const chat = new ChatRunner({ notify: (_m, ev) => events.push(ev) }, { url: "", token: "" }, {
    runtimes: [runtime], developer: () => ({ cwd: "/repo", branch: "dev/test" }),
  });
  return { chat, runtime, events, methods: chatMethods(chat, "test") };
}
const tick = () => new Promise((r) => setImmediate(r));

test("the message is composed once from the panel's parts", () => {
  const text = composeMessage({
    prompt: "make it blue", state: "<aseprite-state/>", changes: "<changes/>", mode: "plan",
    attachments: [{ label: "Selection", uri: "aseprite://selection", path: "/tmp/a.png" }],
  });
  assert.match(text, /^<mode>Plan:[\s\S]*<\/mode>\n<changes\/>\n<aseprite-state\/>\n\nmake it blue\n\[Attached image 1: Selection \(aseprite:\/\/selection\), file \/tmp\/a.png\]$/);
});

test("a turn: busy, events, new conversation id, done", async () => {
  const { chat, runtime, events } = setup();
  chat.send({ prompt: "hi", state: "<s/>", provider: PROVIDERS.claude, sessions: {} });
  assert.equal(chat.busy, true);
  assert.throws(() => chat.send({ prompt: "again", provider: PROVIDERS.claude }), /still working/);
  const { turn, sink, resolve } = runtime.turns[0];
  assert.equal(turn.key, "claude");
  assert.equal(turn.conversationId, undefined);
  assert.equal(turn.message, "<s/>\n\nhi");
  sink.event({ type: "text", text: "hello" });
  sink.event({ type: "conversation", id: "c1" });
  resolve({ conversationId: "c1", stop: "end" });
  await tick();
  assert.equal(chat.busy, false);
  assert.deepEqual(events.filter((e) => e.type === "session"), [{ type: "session", provider: "claude", sessionId: "c1" }], "reported once");
  assert.deepEqual(events.at(-1), { type: "done" });
  assert.ok(events.some((e) => e.type === "text" && e.text === "hello"));
});

test("the panel's sessions map picks the conversation by key; Developer mode has its own", async () => {
  const { chat, runtime } = setup();
  const sessions = { claude: "c1", "claude:dev": "d1", codex: "x1" };
  chat.send({ prompt: "fix it", provider: PROVIDERS.claude, mode: "developer", sessions });
  const t = runtime.turns[0];
  assert.deepEqual([t.turn.key, t.turn.conversationId, t.turn.cwd], ["claude:dev", "d1", "/repo"]);
  t.resolve({ stop: "end" });
  await tick();
  chat.send({ prompt: "hi", provider: PROVIDERS.codex, mode: "ask", sessions });
  assert.deepEqual([runtime.turns[1].turn.key, runtime.turns[1].turn.conversationId], ["codex", "x1"]);
  runtime.turns[1].resolve({ stop: "end" });
  await tick();
  // A key missing from the map starts a new conversation; older panels send sessionId.
  chat.send({ prompt: "hi", provider: PROVIDERS.claude, sessions: { codex: "x1" }, sessionId: "ignored" });
  assert.equal(runtime.turns[2].turn.conversationId, undefined);
  runtime.turns[2].resolve({ stop: "end" });
  await tick();
  chat.send({ prompt: "hi", provider: PROVIDERS.claude, sessionId: "old" });
  assert.equal(runtime.turns[3].turn.conversationId, "old");
});

test("stop: idempotent, settles permissions, reports Stopped., ignores late events", async () => {
  const { chat, runtime, events } = setup();
  chat.send({ prompt: "long", provider: PROVIDERS.claude });
  const { sink } = runtime.turns[0];
  const asked = sink.permission({ title: "Run ls", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] });
  chat.stop();
  chat.stop();
  assert.equal(runtime.stops, 1);
  assert.deepEqual(await asked, { outcome: "cancelled" });
  await tick();
  assert.deepEqual(events.at(-1), { type: "done", text: "Stopped." });
  const n = events.length;
  sink.event({ type: "text", text: "late" });
  assert.equal(events.length, n, "a finished turn's events are dropped");
  assert.equal(chat.busy, false);
});

test("failures and early stops end the turn with a reason", async () => {
  const { chat, runtime, events } = setup();
  chat.send({ prompt: "x", provider: PROVIDERS.claude });
  runtime.turns[0].reject(new Error("agent crashed"));
  await tick();
  assert.deepEqual(events.at(-1), { type: "error", text: "agent crashed" });
  chat.send({ prompt: "y", provider: PROVIDERS.claude });
  runtime.turns[1].resolve({ stop: "early", detail: "max_tokens" });
  await tick();
  assert.deepEqual(events.at(-1), { type: "done", text: "The agent stopped early (max_tokens)." });
});

test("Developer mode needs the ACP runtime", () => {
  const { chat } = setup(fakeRuntime("stream"));
  assert.throws(() => chat.send({ prompt: "x", provider: PROVIDERS.claude, mode: "developer" }), /ACP runtime/);
  assert.equal(chat.busy, false);
});

test("chat.send passes structured parts through", async () => {
  const { runtime, methods } = setup();
  methods["chat.send"]({ prompt: "hi", state: "<s/>", changes: "<c/>", provider: "codex", mode: "plan", sessions: { codex: "x9" } });
  const t = runtime.turns[0].turn;
  assert.equal(t.conversationId, "x9");
  assert.match(t.message, /<c\/>\n<s\/>\n\nhi$/);
});
