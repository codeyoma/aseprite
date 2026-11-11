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
  // A key missing from the map starts a new conversation.
  chat.send({ prompt: "hi", provider: PROVIDERS.claude, sessions: { codex: "x1" } });
  assert.equal(runtime.turns[2].turn.conversationId, undefined);
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
  await methods["chat.send"]({ prompt: "hi", state: "<s/>", changes: "<c/>", provider: "codex", mode: "plan", sessions: { codex: "x9" } });
  const t = runtime.turns[0].turn;
  assert.equal(t.conversationId, "x9");
  assert.match(t.message, /<c\/>\n<s\/>\n\nhi$/);
});

test("every event of a turn carries the panel's chat id", async () => {
  const { runtime, events, methods } = setup();
  await methods["chat.send"]({ prompt: "hi", provider: "claude", sessions: {}, chatId: "c7" });
  const { sink, resolve } = runtime.turns[0];
  sink.event({ type: "text", text: "hello" });
  sink.event({ type: "conversation", id: "s1" });
  resolve({ conversationId: "s1", stop: "end" });
  await tick();
  assert.ok(events.length >= 4);
  assert.ok(events.every((e) => e.chatId === "c7"), JSON.stringify(events));
});

test("Agent after Ask says the read-only note no longer applies, once", async () => {
  const { runtime, methods } = setup();
  await methods["chat.send"]({ prompt: "what is this?", provider: "codex", mode: "ask", sessions: {} });
  runtime.turns[0].resolve({ conversationId: "s1", stop: "end" });
  await tick();
  await methods["chat.send"]({ prompt: "add a layer", provider: "codex", mode: "agent", sessions: { codex: "s1" } });
  assert.match(runtime.turns[1].turn.message, /^<mode>Agent: you may change the document again/);
  runtime.turns[1].resolve({ conversationId: "s1", stop: "end" });
  await tick();
  await methods["chat.send"]({ prompt: "another", provider: "codex", mode: "agent", sessions: { codex: "s1" } });
  assert.doesNotMatch(runtime.turns[2].turn.message, /<mode>Agent/);
});

test("chats run at the same time; Stop stops only its chat (#90)", async () => {
  const runtime = fakeRuntime();
  const stopped = [];
  runtime.stop = (key) => stopped.push(key);
  const { chat, events, methods } = setup(runtime);
  await methods["chat.send"]({ prompt: "a", provider: "claude", sessions: {}, chatId: "c1" });
  await methods["chat.send"]({ prompt: "b", provider: "codex", sessions: {}, chatId: "c2" });
  assert.equal(runtime.turns.length, 2, "both turns started");
  assert.deepEqual(runtime.turns.map((t) => t.turn.chatId), ["c1", "c2"]);
  await assert.rejects(methods["chat.send"]({ prompt: "again", provider: "claude", sessions: {}, chatId: "c1" }), /still working in this chat/);
  assert.equal(chat.currentProvider("c2").id, "codex");
  methods["chat.stop"]({ chatId: "c1" });
  assert.deepEqual(stopped, ["c1|claude"]);
  runtime.turns[1].sink.event({ type: "text", text: "from b" });
  runtime.turns[1].resolve({ conversationId: "s2", stop: "end" });
  runtime.turns[0].resolve({ conversationId: "s1", stop: "cancelled" });
  await tick();
  assert.ok(events.some((e) => e.chatId === "c2" && e.type === "text" && e.text === "from b"));
  assert.ok(events.some((e) => e.chatId === "c1" && e.type === "done" && e.text === "Stopped."));
  assert.equal(chat.busy, false);
});

test("ask: a tool's question goes to the chat's permission prompt; a no stands until the next message (#102)", async () => {
  const runtime = fakeRuntime();
  const { chat, events, methods } = setup(runtime);
  assert.equal(await chat.ask("c1", "image_generator", "the image generator"), false, "no turn running: no");
  await methods["chat.send"]({ prompt: "a", provider: "claude", sessions: {}, chatId: "c1" });
  const yes = chat.ask("c1", "image_generator", "the image generator");
  await tick();
  let p = events.findLast((e) => e.type === "permission");
  assert.equal(p.chatId, "c1");
  assert.deepEqual(p.options.map((o) => o.name), ["Allow once", "Deny"]);
  chat.answerPermission(p.requestId, "allow");
  assert.equal(await yes, true);
  const no = chat.ask("c1", "image_generator", "again");
  await tick();
  p = events.findLast((e) => e.type === "permission");
  chat.answerPermission(p.requestId, "deny");
  assert.equal(await no, false);
  const count = events.filter((e) => e.type === "permission").length;
  assert.equal(await chat.ask("c1", "image_generator", "once more"), false, "declined: not asked again this turn");
  assert.equal(events.filter((e) => e.type === "permission").length, count);
  runtime.turns[0].resolve({ conversationId: "s1", stop: "end" });
  await tick();
  await methods["chat.send"]({ prompt: "b", provider: "claude", sessions: {}, chatId: "c1" });
  const after = chat.ask("c1", "image_generator", "next message");
  await tick();
  assert.equal(events.filter((e) => e.type === "permission").length, count + 1, "asked again after the next message");
  chat.answerPermission(events.findLast((e) => e.type === "permission").requestId, null);
  assert.equal(await after, false);
});
