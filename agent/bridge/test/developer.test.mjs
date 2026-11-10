// Developer mode (#28): the agent's worktree, status, apply, discard, and the agents' tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.ASEPRITE_AGENT_DEV_DIR = mkdtempSync(join(tmpdir(), "devdir-"));
const { applyDev, currentBranch, devState, devStatus, discard, ensureDevWorktree, slug } = await import("../dist/developer.js");
import { chatMode, conversationKey } from "../dist/chat.js";
import { PROVIDERS } from "../dist/providers/index.js";

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "devrepo-"));
  git(dir, "init", "-q", "-b", "agent");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "agent", "extension"), { recursive: true });
  writeFileSync(join(dir, "agent", "extension", "chat_panel.lua"), "local P = 'Draw'\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("slug", () => {
  assert.equal(slug("Make the chat input placeholder say Hi!"), "make-the-chat-input");
  assert.equal(slug("!!!"), "change");
});

const read = (...p) => readFileSync(join(...p), "utf8");
const commitAll = (cwd, msg) => { git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg); };

test("the agent works in its own worktree; the user's checkout stays put", () => {
  const dir = repo();
  const w = ensureDevWorktree(dir, "Make the placeholder friendlier", new Date("2026-11-10T00:00:00Z"));
  assert.equal(w.branch, "dev/20261110-make-the-placeholder-friendlier");
  assert.notEqual(w.cwd, dir);
  assert.equal(currentBranch(dir), "agent", "the user's checkout stays on its branch");
  assert.equal(currentBranch(w.cwd), w.branch);
  assert.deepEqual(ensureDevWorktree(dir, "another request"), w, "the same worktree for the next turn");

  writeFileSync(join(w.cwd, "agent", "extension", "chat_panel.lua"), "local P = 'Hi'\n");
  let s = devStatus(dir);
  assert.deepEqual([s.branch, s.base, s.files, s.uncommitted, s.needsBuild], [w.branch, "agent", ["agent/extension/chat_panel.lua"], ["agent/extension/chat_panel.lua"], false]);
  assert.equal(read(dir, "agent", "extension", "chat_panel.lua"), "local P = 'Draw'\n", "the user's files are untouched");
  assert.throws(() => applyDev(dir), /hasn't committed/);

  commitAll(w.cwd, "friendlier");
  mkdirSync(join(w.cwd, "src"));
  writeFileSync(join(w.cwd, "src", "x.cpp"), "int x;\n");
  commitAll(w.cwd, "c++");
  s = devStatus(dir);
  assert.ok(s.needsBuild && s.files.includes("src/x.cpp") && !s.uncommitted.length);
  assert.match(s.diffStat, /chat_panel\.lua \| 2/, "the base branch is named like the agent/ folder");
});

test("apply fast-forwards the user's branch; discard undoes it while nothing changed since", () => {
  const dir = repo();
  const before = git(dir, "rev-parse", "HEAD").stdout.trim();
  const w = ensureDevWorktree(dir, "fix");
  writeFileSync(join(w.cwd, "agent", "extension", "chat_panel.lua"), "local P = 'Hi'\n");
  commitAll(w.cwd, "hi");

  // The user's checkout must be on its branch with no tracked changes.
  writeFileSync(join(dir, "agent", "extension", "chat_panel.lua"), "local P = 'mine'\n");
  assert.throws(() => applyDev(dir), /uncommitted changes/);
  git(dir, "checkout", "--", ".");
  writeFileSync(join(dir, "notes.txt"), "untracked files are fine\n");

  const a = applyDev(dir);
  assert.equal(a.commits, 1);
  assert.equal(read(dir, "agent", "extension", "chat_panel.lua"), "local P = 'Hi'\n");
  assert.equal(devState(dir).phase, "applied");
  // More work, applied again.
  writeFileSync(join(w.cwd, "agent", "extension", "chat_panel.lua"), "local P = 'Hello'\n");
  commitAll(w.cwd, "hello");
  assert.equal(applyDev(dir).commits, 1);
  assert.equal(applyDev(dir).commits, 0, "nothing new");

  const d = discard(dir);
  assert.ok(d.reverted);
  assert.equal(git(dir, "rev-parse", "HEAD").stdout.trim(), before, "back where it was before the first apply");
  assert.ok(existsSync(join(dir, "notes.txt")), "untracked files survive");
  assert.ok(!existsSync(w.cwd), "the worktree is gone");
  assert.equal(devState(dir), undefined);
  assert.ok(git(dir, "rev-parse", "--verify", w.branch).status === 0, "the dev branch keeps the commits");
});

test("apply and discard refuse when the user's branch moved", () => {
  const dir = repo();
  const w = ensureDevWorktree(dir, "a change");
  writeFileSync(join(w.cwd, "a.txt"), "agent\n");
  commitAll(w.cwd, "agent work");
  writeFileSync(join(dir, "b.txt"), "user\n");
  commitAll(dir, "user work");
  assert.throws(() => applyDev(dir), /moved since the agent started; ask it to rebase/);
  git(w.cwd, "rebase", "-q", "agent");
  applyDev(dir);
  writeFileSync(join(dir, "c.txt"), "more user work\n");
  commitAll(dir, "after apply");
  assert.throws(() => discard(dir), /can't be undone safely/);
});

test("discard before apply stashes the agent's uncommitted work", () => {
  const dir = repo();
  const w = ensureDevWorktree(dir, "try");
  writeFileSync(join(w.cwd, "draft.lua"), "-- draft\n");
  const d = discard(dir);
  assert.equal(d.stash, "stash@{0}");
  assert.ok(!d.reverted);
  assert.match(git(dir, "stash", "list").stdout, /aseprite-agent: discarded from dev\//);
  assert.ok(!existsSync(w.cwd));
  assert.equal(currentBranch(dir), "agent");
});

test("developer conversations and tools are separate from normal ones", () => {
  assert.equal(chatMode("developer"), "developer");
  assert.equal(conversationKey("claude", "developer"), "claude:dev");
  assert.equal(conversationKey("claude", "ask"), "claude");
  const opts = (mode) => PROVIDERS.claude.acp.sessionMeta("p", mode).claudeCode.options;
  assert.deepEqual(opts("agent").tools, ["Bash", "TodoWrite"], "Agent mode: the shell and the to-do list, no other coding tools");
  assert.deepEqual(opts("ask").tools, [], "Ask mode: no built-in tools");
  assert.deepEqual(opts("plan").tools, []);
  assert.equal(opts("developer").tools, undefined, "Developer mode keeps Claude Code's tools");
  assert.ok(!opts("agent").allowedTools.includes("Bash"), "each shell command asks the user");
  const sandbox = (mode) => JSON.parse(PROVIDERS.codex.acp.env("p", mode).CODEX_CONFIG).sandbox_mode;
  assert.equal(sandbox("developer"), "workspace-write");
  assert.equal(sandbox("agent"), undefined);
  assert.equal(sandbox("ask"), "read-only");
  assert.equal(sandbox("plan"), "read-only");
});

// dev.build and dev.relaunch with fakes for ninja, the clock, timers and Aseprite.
test("dev.build throttles progress and reports the result", async () => {
  const { developerMethods, BUILD_PROGRESS_MS } = await import("../dist/developer_methods.js");
  const events = [];
  let clock = 0;
  let finish;
  const lines = [[0, "[1/9] a.cpp"], [100, "[2/9] b.cpp"], [BUILD_PROGRESS_MS + 1, "[3/9] c.cpp"], [BUILD_PROGRESS_MS + 50, "[4/9] d.cpp"],
    [2 * BUILD_PROGRESS_MS + 2, "x".repeat(200)]];
  const methods = developerMethods({
    notify: (ev) => events.push(ev),
    root: () => "/repo",
    now: () => clock,
    build: (root, onLine) => {
      assert.equal(root, "/repo");
      for (const [t, l] of lines) {
        clock = t;
        onLine(l);
      }
      return new Promise((r) => (finish = r));
    },
  });
  assert.deepEqual(methods["dev.build"](), { started: true });
  assert.deepEqual(events.map((e) => e.text), ["Building: [1/9] a.cpp", "Building: [3/9] c.cpp", `Building: ${"x".repeat(120)}`]);
  assert.ok(events.every((e) => e.type === "status"));
  finish({ ok: false, tail: "error: b.cpp" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.at(-1), { type: "build", ok: false, text: "error: b.cpp" });
});

test("dev.relaunch waits for Aseprite to disconnect, then launches the build", async () => {
  const { developerMethods, RELAUNCH_DELAY_MS } = await import("../dist/developer_methods.js");
  const launched = [], timers = [];
  const listeners = {};
  const link = { connected: true, once: (ev, fn) => (listeners[ev] = fn) };
  const methods = developerMethods({
    notify: () => {},
    link,
    root: () => "/repo",
    binary: (root) => `${root}/build/bin/aseprite`,
    launch: (bin) => launched.push(bin),
    delay: (fn, ms) => timers.push({ fn, ms }),
  });
  assert.deepEqual(methods["dev.relaunch"](), { relaunching: true, bin: "/repo/build/bin/aseprite" });
  assert.equal(timers.length, 0, "nothing starts while Aseprite is still connected");
  listeners.disconnected();
  assert.equal(timers[0].ms, RELAUNCH_DELAY_MS);
  assert.deepEqual(launched, []);
  timers[0].fn();
  assert.deepEqual(launched, ["/repo/build/bin/aseprite"]);

  // Not connected: the delay starts at once. No build or no clone: an error.
  link.connected = false;
  methods["dev.relaunch"]();
  assert.equal(timers.length, 2);
  const noBuild = developerMethods({ notify: () => {}, root: () => "/repo", binary: () => undefined });
  assert.throws(() => noBuild["dev.relaunch"](), /No build of the fork/);
  const noRepo = developerMethods({ notify: () => {}, root: () => undefined });
  assert.throws(() => noRepo["dev.status"](), /not running from a clone/);
});
