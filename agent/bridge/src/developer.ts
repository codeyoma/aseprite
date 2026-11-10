// Developer mode (#28): the chat agent edits this Aseprite fork (the git
// repository the bridge lives in) with its normal coding tools, on a branch
// dev/<date>-<slug>, and the panel rebuilds and relaunches Aseprite.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
Rules: work on the current dev/ branch and commit your changes there with a clear message; never push, never switch branches, never rewrite history. Never distribute builds of this fork (Aseprite EULA). Keep changes small and in the style of the surrounding code.
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

/**
 * Puts the repository on a dev/ branch before a developer turn: keeps the
 * current one if it is already a dev/ branch, otherwise creates
 * dev/<yyyymmdd>-<slug> from HEAD and remembers the branch it came from.
 */
export function ensureDevBranch(root: string, prompt: string, now = new Date()): string {
  const current = currentBranch(root);
  if (current.startsWith("dev/")) return current;
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  let name = `dev/${date}-${slug(prompt)}`;
  for (let i = 2; git(root, "rev-parse", "--verify", "--quiet", name).ok; i++) name = `dev/${date}-${slug(prompt)}-${i}`;
  const r = git(root, "switch", "-c", name);
  if (!r.ok) throw new Error(`Could not create branch ${name}: ${r.out}`);
  git(root, "config", `branch.${name}.aseprite-agent-base`, current);
  return name;
}

export interface DevStatus {
  repo: string;
  branch: string;
  base?: string;
  /** Files changed on the branch (committed since base, or uncommitted). */
  files: string[];
  diffStat: string;
  /** True when a C++ (or other non-extension) file changed, so Aseprite must be rebuilt. */
  needsBuild: boolean;
}

export function devStatus(root: string): DevStatus {
  const branch = currentBranch(root);
  const base = git(root, "config", `branch.${branch}.aseprite-agent-base`).out || undefined;
  const range = base ? [`${base}...HEAD`] : [];
  // "--" ends the revisions: the base branch may share its name with a folder (agent/).
  const committed = base ? git(root, "diff", "--name-only", ...range, "--").out.split("\n") : [];
  // Porcelain lines are "XY path"; read them untrimmed (X may be a space).
  const porcelain = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).stdout ?? "";
  const working = porcelain.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ""));
  const files = [...new Set([...committed, ...working].filter(Boolean))].sort();
  const stat = git(root, "diff", "--stat", base ?? "HEAD", "--").out;
  const needsBuild = files.some((f) => /^(src|laf|third_party)\//.test(f) || /\.(cpp|h|cmake|txt)$/.test(f));
  return { repo: root, branch, base, files, diffStat: stat, needsBuild };
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

/**
 * Discards the dev branch's uncommitted changes into a stash (recoverable
 * with `git stash pop`) and switches back to the branch it came from. The
 * dev branch and its commits stay.
 */
export function discard(root: string): { stash?: string; branch: string } {
  const branch = currentBranch(root);
  const base = git(root, "config", `branch.${branch}.aseprite-agent-base`).out;
  let stash: string | undefined;
  if (git(root, "status", "--porcelain").out) {
    const r = git(root, "stash", "push", "-u", "-m", `aseprite-agent: discarded from ${branch}`);
    if (!r.ok) throw new Error(`Could not stash the changes: ${r.out}`);
    stash = "stash@{0}";
  }
  if (base) {
    const r = git(root, "switch", base);
    if (!r.ok) throw new Error(`Could not switch back to ${base}: ${r.out}`);
  }
  return { stash, branch: base || branch };
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
