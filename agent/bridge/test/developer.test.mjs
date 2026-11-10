// Developer mode (#28): branches, status, discard, and the agents' tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, devStatus, discard, ensureDevBranch, slug } from "../dist/developer.js";
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

test("a developer turn runs on a dev/ branch that remembers its base", () => {
  const dir = repo();
  const b = ensureDevBranch(dir, "Make the placeholder friendlier", new Date("2026-11-10T00:00:00Z"));
  assert.equal(b, "dev/20261110-make-the-placeholder-friendlier");
  assert.equal(currentBranch(dir), b);
  assert.equal(ensureDevBranch(dir, "another request"), b, "stays on the dev branch");

  writeFileSync(join(dir, "agent", "extension", "chat_panel.lua"), "local P = 'Hi'\n");
  let s = devStatus(dir);
  assert.deepEqual([s.branch, s.base, s.files, s.needsBuild], [b, "agent", ["agent/extension/chat_panel.lua"], false]);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "x.cpp"), "int x;\n");
  s = devStatus(dir);
  assert.ok(s.needsBuild && s.files.includes("src/x.cpp"));

  const d = discard(dir);
  assert.equal(d.branch, "agent");
  assert.equal(currentBranch(dir), "agent");
  assert.equal(readFileSync(join(dir, "agent", "extension", "chat_panel.lua"), "utf8"), "local P = 'Draw'\n");
  assert.ok(!existsSync(join(dir, "src", "x.cpp")));
  assert.match(git(dir, "stash", "list").stdout, /aseprite-agent: discarded from dev\//, "changes are kept in a stash");
});

test("developer conversations and tools are separate from normal ones", () => {
  assert.equal(chatMode("developer"), "developer");
  assert.equal(conversationKey("claude", "developer"), "claude:dev");
  assert.equal(conversationKey("claude", "ask"), "claude");
  const normal = PROVIDERS.claude.acp.sessionMeta("p", false).claudeCode.options;
  const dev = PROVIDERS.claude.acp.sessionMeta("p", true).claudeCode.options;
  assert.deepEqual(normal.tools, [], "normal chats have no coding tools");
  assert.equal(dev.tools, undefined, "Developer mode keeps Claude Code's tools");
  assert.equal(JSON.parse(PROVIDERS.codex.acp.env("p", true).CODEX_CONFIG).sandbox_mode, "workspace-write");
  assert.equal(JSON.parse(PROVIDERS.codex.acp.env("p", false).CODEX_CONFIG).sandbox_mode, undefined);
});
