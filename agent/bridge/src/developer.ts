// Developer mode (#28): the chat agent edits this Aseprite fork (the git
// repository the bridge lives in) with its normal coding tools, in a
// worktree of its own on a branch dev/<date>-<slug>; Apply brings the work
// into the user's checkout, and the panel rebuilds and relaunches Aseprite.
import { sessionDir } from "./session.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The fork's repository root (ASEPRITE_AGENT_REPO overrides), or undefined outside a clone. */
export function repoRoot(): string | undefined {
  const fromEnv = process.env.ASEPRITE_AGENT_REPO;
  if (fromEnv) return resolve(fromEnv);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return existsSync(join(root, ".git")) && existsSync(join(root, "agent", "bridge")) ? root : undefined;
}

export const DEVELOPER_PROMPT = `You are in Developer mode inside the "AI Agent" panel of a personal fork of Aseprite. The user wants you to change Aseprite itself: this repository is your working directory.
Layout: src/ is Aseprite's C++ source (src/app/script for the Lua API, src/app/ui for widgets); agent/extension is the Lua extension that draws this chat panel (chat_panel.lua, conversation.lua, agent.lua); agent/bridge is the Node bridge (TypeScript in src/, tests in test/); agent/guide is the agent guide; agent/tests has batch tests.
Build: C++ changes need \`ninja aseprite\` in build/ (the panel's Rebuild & Relaunch does it); extension Lua changes only need a relaunch; bridge changes need \`npm run build\` in agent/bridge. Tests: \`npm test\` in agent/bridge; batch tests with build/bin/aseprite -b --script-param ext=<agent/extension> --script agent/tests/<name>_test.lua.
Your working directory is a git worktree of your own on a dev/ branch; the user's checkout stays untouched until they apply your work. Commit your changes there with a clear message; never push or switch branches. If applying says the user's branch moved, rebase your branch onto it (the only history rewrite allowed). Git submodules (laf, third_party) aren't checked out here and C++ builds run in the user's checkout after Apply, so don't build C++ yourself; for bridge tests run \`npm ci\` in agent/bridge first. Never distribute builds of this fork (Aseprite EULA). Keep changes small and in the style of the surrounding code.
When you are done, say what you changed and whether it needs a rebuild (C++) or only a relaunch (Lua). The user applies it with Rebuild & Relaunch in the panel. You also have the aseprite MCP tools to look at the running app.`;

function git(root: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function currentBranch(root: string): string {
  return git(root, "rev-parse", "--abbrev-ref", "HEAD").out;
}

/** "Make the input placeholder say Hi!" -> "make-the-input-placeholder" */
export function slug(text: string): string {
  return (
    text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "change"
  );
}

// ---------------------------------------------------------------------------
// The developer worktree
// ---------------------------------------------------------------------------
//
// The agent edits a git worktree of its own on a dev/ branch, so the user's
// checkout (where they, or other agents, may be working) never changes
// until they apply the work. Apply fast-forwards the user's branch to the
// dev branch; the running Aseprite loads the extension and builds from the
// user's checkout. The state is kept on disk, so it survives restarts.

/** Where worktrees and their state live (ASEPRITE_AGENT_DEV_DIR overrides). */
export function devDir(): string {
  return process.env.ASEPRITE_AGENT_DEV_DIR ?? join(sessionDir, "dev");
}

export interface DevState {
  /** The user's checkout. */
  repo: string;
  /** The agent's worktree and its dev/ branch. */
  worktree: string;
  branch: string;
  /** The user's branch the work started from, and its commit then. */
  base: string;
  baseSha: string;
  /** "applied": the user's branch was fast-forwarded to appliedTip from appliedFrom. */
  phase: "editing" | "applied";
  appliedFrom?: string;
  appliedTip?: string;
}

const stateFile = () => join(devDir(), "state.json");

export function devState(root: string): DevState | undefined {
  try {
    const st = JSON.parse(readFileSync(stateFile(), "utf8")) as DevState;
    return st.repo === root && existsSync(st.worktree) ? st : undefined;
  } catch {
    return undefined;
  }
}

function saveState(st: DevState | undefined): void {
  if (!st) {
    rmSync(stateFile(), { force: true });
    return;
  }
  mkdirSync(devDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(st, null, 2));
}

const sha = (root: string, ref: string) => git(root, "rev-parse", "--verify", ref).out;
/** Tracked files with changes ("XY path" lines); untracked files don't count. */
const trackedChanges = (root: string) => git(root, "status", "--porcelain", "--untracked-files=no").out;

/**
 * The agent's worktree for a developer turn: the current one, or a new
 * worktree on dev/<yyyymmdd>-<slug> from the user's current branch. The
 * user's checkout stays on its branch.
 */
export function ensureDevWorktree(root: string, prompt: string, now = new Date()): { cwd: string; branch: string } {
  const st = devState(root);
  if (st) return { cwd: st.worktree, branch: st.branch };
  const base = currentBranch(root);
  if (base === "HEAD") throw new Error("Developer mode needs the repository on a branch (it is on a detached HEAD)");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  let name = `dev/${date}-${slug(prompt)}`;
  for (let i = 2; git(root, "rev-parse", "--verify", "--quiet", name).ok; i++) name = `dev/${date}-${slug(prompt)}-${i}`;
  const worktree = join(devDir(), "worktrees", name.replace(/\//g, "-"));
  mkdirSync(dirname(worktree), { recursive: true });
  const baseSha = sha(root, "HEAD");
  const r = git(root, "worktree", "add", "-b", name, worktree, baseSha);
  if (!r.ok) throw new Error(`Could not create the developer worktree: ${r.out}`);
  saveState({ repo: root, worktree, branch: name, base, baseSha, phase: "editing" });
  return { cwd: worktree, branch: name };
}

export interface DevStatus {
  repo: string;
  /** The agent's worktree, or undefined when there is no developer work. */
  worktree?: string;
  branch: string;
  base?: string;
  phase?: DevState["phase"];
  /** Files changed on the dev branch (committed since it started, or uncommitted in the worktree). */
  files: string[];
  /** Files changed but not committed in the worktree; Apply waits for them. */
  uncommitted: string[];
  diffStat: string;
  /** True when a C++ (or other non-extension) file changed, so Aseprite must be rebuilt. */
  needsBuild: boolean;
}

export function devStatus(root: string): DevStatus {
  const st = devState(root);
  if (!st) return { repo: root, branch: currentBranch(root), files: [], uncommitted: [], diffStat: "", needsBuild: false };
  // "--" ends the revisions: a branch may share its name with a folder (agent/).
  const committed = git(root, "diff", "--name-only", `${st.baseSha}..${st.branch}`, "--").out.split("\n").filter(Boolean);
  // Porcelain lines are "XY path"; read them untrimmed (X may be a space).
  const porcelain = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: st.worktree, encoding: "utf8" }).stdout ?? "";
  const uncommitted = porcelain.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ""));
  const files = [...new Set([...committed, ...uncommitted])].sort();
  const needsBuild = files.some((f) => /^(src|laf|third_party)\//.test(f) || /\.(cpp|h|cmake|txt)$/.test(f));
  return {
    repo: root, worktree: st.worktree, branch: st.branch, base: st.base, phase: st.phase,
    files, uncommitted, diffStat: git(root, "diff", "--stat", `${st.baseSha}..${st.branch}`, "--").out, needsBuild,
  };
}

/**
 * Applies the agent's committed work: fast-forwards the user's branch in
 * their checkout to the dev branch. Refuses when the worktree has
 * uncommitted changes, the checkout is on another branch or has changes
 * to tracked files, or the user's branch moved (the agent rebases then).
 * Applying again after more commits fast-forwards further.
 */
export function applyDev(root: string): { from: string; to: string; commits: number } {
  const st = devState(root);
  if (!st) throw new Error("There is no developer work to apply");
  const status = devStatus(root);
  if (status.uncommitted.length) throw new Error(`The agent hasn't committed ${status.uncommitted.join(", ")}; ask it to commit first`);
  if (currentBranch(root) !== st.base) throw new Error(`Your checkout is on ${currentBranch(root)}; switch it back to ${st.base} to apply`);
  const dirty = trackedChanges(root);
  if (dirty) throw new Error(`Your checkout has uncommitted changes; commit or stash them first:\n${dirty}`);
  const head = sha(root, "HEAD"), tip = sha(root, st.branch);
  if (head === tip) return { from: head, to: tip, commits: 0 };
  if (!git(root, "merge-base", "--is-ancestor", head, tip).ok) {
    throw new Error(`${st.base} moved since the agent started; ask it to rebase ${st.branch} onto ${st.base} first`);
  }
  const commits = Number(git(root, "rev-list", "--count", `${head}..${tip}`).out) || 0;
  const r = git(root, "merge", "--ff-only", tip);
  if (!r.ok) throw new Error(`Could not apply: ${r.out}`);
  saveState({ ...st, phase: "applied", appliedFrom: st.appliedFrom ?? head, appliedTip: tip });
  return { from: head, to: tip, commits };
}

/**
 * Discards the agent's work: its uncommitted changes go into a stash
 * (recoverable with `git stash pop`), the worktree is removed, and the dev
 * branch stays with its commits. After an Apply, the user's branch is
 * also reset to where it was, but only while it is still exactly the
 * applied commit with no changes to tracked files.
 */
export function discard(root: string): { stash?: string; branch: string; reverted?: boolean } {
  const st = devState(root);
  if (!st) throw new Error("There is no developer work to discard");
  let reverted = false;
  if (st.phase === "applied") {
    const head = sha(root, "HEAD");
    if (currentBranch(root) !== st.base || head !== st.appliedTip || trackedChanges(root)) {
      throw new Error(`${st.base} changed after the agent's work was applied, so it can't be undone safely; revert the commits with git instead`);
    }
    const r = git(root, "reset", "--hard", st.appliedFrom!);
    if (!r.ok) throw new Error(`Could not undo the applied work: ${r.out}`);
    reverted = true;
  }
  let stash: string | undefined;
  if (git(st.worktree, "status", "--porcelain").out) {
    const r = git(st.worktree, "stash", "push", "-u", "-m", `aseprite-agent: discarded from ${st.branch}`);
    if (!r.ok) throw new Error(`Could not stash the agent's changes: ${r.out}`);
    stash = "stash@{0}";
  }
  const r = git(root, "worktree", "remove", "--force", st.worktree);
  if (!r.ok) throw new Error(`Could not remove the worktree: ${r.out}`);
  saveState(undefined);
  return { stash, branch: st.base, reverted };
}

/** Runs `ninja aseprite` in build/, calling onLine for each output line. */
export function build(root: string, onLine: (line: string) => void): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolveBuild) => {
    const dir = join(root, "build");
    if (!existsSync(dir)) {
      resolveBuild({ ok: false, tail: `No build folder at ${dir}. Configure the build first (agent/docs/BUILD-macos.md).` });
      return;
    }
    const proc = spawn("ninja", ["aseprite"], { cwd: dir });
    const lines: string[] = [];
    let partial = "";
    const take = (chunk: Buffer) => {
      partial += chunk.toString();
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const l of parts) {
        lines.push(l);
        if (lines.length > 400) lines.shift();
        onLine(l);
      }
    };
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    proc.on("error", (err) => resolveBuild({ ok: false, tail: `Could not run ninja: ${err.message}` }));
    proc.on("close", (code) => {
      if (partial) lines.push(partial);
      // Errors first: the lines around "error:" are what the agent needs.
      const errorLines = lines.filter((l) => /error|FAILED/i.test(l));
      const tail = (code === 0 ? lines.slice(-5) : [...errorLines.slice(0, 40), "...", ...lines.slice(-15)]).join("\n");
      resolveBuild({ ok: code === 0, tail });
    });
  });
}

/** The Aseprite binary to relaunch: the fork's build. */
export function asepriteBinary(root: string): string | undefined {
  const bin = join(root, "build", "bin", "aseprite");
  return existsSync(bin) ? bin : undefined;
}

/** Starts Aseprite detached from the bridge, so it outlives it. */
export function launch(bin: string): void {
  const child = spawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref();
}
