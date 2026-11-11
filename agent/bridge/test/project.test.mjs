// Project memory and checkpoints (#93), bridge side: the chat's folder, the
// project's AGENTS.md, the recap block, remember_style.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { agentsMd, ConversationDirs, ensureProject, MEMORY_END, MEMORY_START, projectDirOf, turnDir, withMemory } from "../dist/project.js";
import { ChatRunner, composeMessage, earlierConversation, HISTORY_MAX } from "../dist/chat.js";
import { PROVIDERS } from "../dist/providers/index.js";
import { findTool, runTool, toolContext } from "../dist/tools.js";

const tmp = () => mkdtempSync(join(tmpdir(), "project-test-"));

test("AGENTS.md is created once, its style memory section kept current, a user's file left alone", () => {
  const dir = tmp();
  assert.equal(ensureProject(dir), "created");
  const file = join(dir, "AGENTS.md");
  const first = readFileSync(file, "utf8");
  assert.match(first, /an Aseprite project/);
  assert.match(first, /remember_style/);
  assert.ok(first.includes(MEMORY_START) && first.includes(MEMORY_END));
  assert.equal(ensureProject(dir), "kept", "no memory sent: untouched");
  assert.equal(ensureProject(dir, [{ topic: "outline", text: "1 px  dark selout" }]), "updated");
  assert.match(readFileSync(file, "utf8"), /- outline: 1 px dark selout\n<!-- aseprite-agent:style-memory:end -->/);
  assert.equal(ensureProject(dir, [{ topic: "outline", text: "1 px dark selout" }]), "kept", "same memory: no write");

  const mine = tmp();
  writeFileSync(join(mine, "AGENTS.md"), "# My notes\n");
  assert.equal(ensureProject(mine, [{ topic: "note", text: "x" }]), "kept");
  assert.equal(readFileSync(join(mine, "AGENTS.md"), "utf8"), "# My notes\n");
  assert.equal(withMemory("no markers", []), undefined);
  assert.match(agentsMd("/a/b/heroes"), /^# heroes: an Aseprite project/);
});

test("the project folder is a saved sprite's folder, never home or a missing one", () => {
  const dir = tmp();
  assert.equal(projectDirOf(join(dir, "hero.aseprite")), dir);
  assert.equal(projectDirOf("Sprite-0001"), undefined, "unsaved");
  assert.equal(projectDirOf(undefined), undefined);
  assert.equal(projectDirOf(join(dir, "gone", "hero.aseprite")), undefined);
  assert.equal(projectDirOf(join(homedir(), "hero.aseprite")), undefined, "home is too broad");
});

test("a known conversation keeps its folder; a new one starts in the sprite's", () => {
  const dir = tmp(), workspace = tmp(), other = tmp();
  const dirs = new ConversationDirs(join(tmp(), "dirs.json"));
  assert.deepEqual(turnDir({ dirs, spriteFile: join(dir, "a.aseprite"), workspace }), { cwd: dir, project: dir });
  assert.deepEqual(turnDir({ dirs, spriteFile: "Sprite-1", workspace }), { cwd: workspace, project: undefined });
  // Started before #93 (no record): the shared workspace, where it was made.
  assert.deepEqual(turnDir({ dirs, conversationId: "old", spriteFile: join(dir, "a.aseprite"), workspace }), { cwd: workspace, project: undefined });
  dirs.set("c1", other);
  assert.deepEqual(turnDir({ dirs, conversationId: "c1", spriteFile: join(dir, "a.aseprite"), workspace }), { cwd: other, project: other });
  // Saved to a file and read back.
  const file = join(tmp(), "d.json");
  new ConversationDirs(file).set("x", other);
  assert.equal(new ConversationDirs(file).get("x"), other);
});

test("the recap goes first as an earlier-conversation block, cut from the start when long", () => {
  const text = composeMessage({ prompt: "shade it", state: "<s/>", history: "User: draw\nAgent: Drew." });
  assert.match(text, /^<earlier-conversation note="[^"]+">\nUser: draw\nAgent: Drew.\n<\/earlier-conversation>\n<s\/>\n\nshade it$/);
  const long = earlierConversation("A".repeat(HISTORY_MAX) + "END");
  assert.ok(long.includes("[...]") && long.includes("END") && long.length < HISTORY_MAX + 400);
  assert.equal(earlierConversation("  "), undefined);
});

function fakeRuntime() {
  const turns = [];
  return {
    name: "acp", turns, supports: () => true,
    start(turn) { return new Promise((resolve) => turns.push({ turn, resolve })); },
    stop() {}, dispose() {},
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("chat turns run in the sprite's folder, write AGENTS.md there, and keep the folder for the conversation", async () => {
  const runtime = fakeRuntime();
  const chat = new ChatRunner({ notify() {} }, { url: "", token: "" }, { runtimes: [runtime], dirsFile: null });
  const dir = tmp(), later = tmp();
  chat.send({ prompt: "hi", provider: PROVIDERS.claude, chatId: "c1", spriteFile: join(dir, "hero.aseprite"), memory: [{ topic: "scale", text: "16x16" }] });
  assert.equal(runtime.turns[0].turn.cwd, dir);
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /- scale: 16x16/);
  runtime.turns[0].resolve({ conversationId: "conv-1", stop: "end" });
  await tick();
  // Saved elsewhere later (Save As): the conversation stays in its folder.
  chat.send({ prompt: "more", provider: PROVIDERS.claude, chatId: "c1", sessions: { claude: "conv-1" }, spriteFile: join(later, "hero.aseprite") });
  assert.equal(runtime.turns[1].turn.cwd, dir);
  assert.equal(existsSync(join(later, "AGENTS.md")), false);
  runtime.turns[1].resolve({ conversationId: "conv-1", stop: "end" });
  await tick();
  // An unsaved sprite's new conversation: the shared workspace.
  chat.send({ prompt: "x", provider: PROVIDERS.claude, chatId: "c2" });
  assert.match(runtime.turns[2].turn.cwd, /workspace$/);
  runtime.turns[2].resolve({ stop: "end" });
  await tick();
});

test("remember_style posts a memory card to the chat, and refuses outside the panel", async () => {
  const tool = findTool("remember_style");
  const posted = [];
  const fake = { request: async () => ({ result: {} }) };
  const res = await runTool(tool, { topic: "palette", text: "#222  = outline" }, toolContext(fake, { post: (ev) => posted.push(ev) }));
  assert.equal(res.isError, undefined);
  assert.deepEqual(posted, [{ type: "memory", topic: "palette", text: "#222 = outline" }]);
  const none = await runTool(tool, { topic: "note", text: "x" }, toolContext(fake));
  assert.equal(none.isError, true);
});
