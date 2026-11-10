// Shared harness for the live tests (agent/tests/*_live.mjs): a bridge
// connected to the running Aseprite, Lua through execute_lua, chat turns
// through the panel's AsepriteAgent API, and PASS/FAIL reporting.
//
// Hard checks (check) prove the feature ran: the header names the skill, the
// result exists, `check` reports 0 errors. A FAIL there is a bug. Soft checks
// (soft) score what the model chose (layer and tag names, thresholds, timing):
// they print SOFT-PASS or SOFT-FAIL and never fail the test.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

/** The repository's current branch (Developer mode turns can switch it). */
const branch = () => spawnSync("git", ["branch", "--show-current"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).stdout.trim();

/** Modules in agent/extension that the installed extension doesn't link (tools/link_extension.sh fixes it). */
function unlinkedModules() {
  const src = fileURLToPath(new URL("../extension/", import.meta.url));
  const dest = join(homedir(), "Library", "Application Support", "Aseprite", "extensions", "aseprite-agent");
  if (!existsSync(dest)) return [];
  return readdirSync(src).filter((f) => /\.(lua|json)$/.test(f) && f !== "__pref.lua" && !existsSync(join(dest, f)));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A built-in skill's title (the turn header shows it), from agent/skills/<name>/SKILL.md. */
export function skillTitle(name) {
  const file = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
  if (!existsSync(file)) throw new Error(`No built-in skill named ${name}`);
  return /^title:\s*(.+?)\s*$/m.exec(readFileSync(file, "utf8"))?.[1] ?? name;
}

/**
 * provider: the chat provider for chat() ("claude" or "codex").
 * Returns { c, lua, chat, waitIdle, sleep, check, soft, ranSkill, done }.
 */
export async function live({ provider = "claude", bridge = {} } = {}) {
  const startBranch = branch();
  const missing = unlinkedModules();
  if (missing.length) console.warn(`WARNING: the installed extension lacks ${missing.join(", ")}; run agent/tools/link_extension.sh and restart Aseprite`);
  const c = await startBridge(bridge);
  await waitForAseprite(c);

  /** Runs Lua in Aseprite and returns its value (undefined when it returns nothing). */
  const lua = async (code) => {
    const r = await c.call("execute_lua", { code, transaction: false });
    if (r.isError) throw new Error(textOf(r));
    const t = textOf(r);
    return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
  };

  /** Waits until the chat turn ends; returns the seconds it took. */
  const waitIdle = async (timeout = 600_000, every = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(every);
      if (!(await lua("return AsepriteAgent.isBusy()"))) return Math.round((Date.now() - t0) / 1000);
    }
    throw new Error("turn did not end");
  };

  const headers = async () => ((await lua("return AsepriteAgent.entries()")) ?? []).filter((e) => e.kind === "header");
  let headersBefore = 0;

  /** Sends a chat message as the user would; mode null uses the panel's current mode. */
  const chat = async (prompt, { mode = "agent", wait = true, timeout, as = provider } = {}) => {
    headersBefore = (await headers()).length;
    const args = [JSON.stringify(prompt), JSON.stringify(as), ...(mode ? [JSON.stringify(mode)] : [])];
    await lua(`AsepriteAgent.chat(${args.join(", ")}) return true`);
    return wait ? waitIdle(timeout) : undefined;
  };

  let failed = 0;
  /** A hard check: FAIL fails the test. */
  const check = (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
    if (!ok) failed++;
    return ok;
  };

  const softs = { passed: 0, failed: 0 };
  /** A soft check on a model choice: SOFT-FAIL is reported but doesn't fail the test. */
  const soft = (name, ok, detail) => {
    console.log(`${ok ? "SOFT-PASS" : "SOFT-FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
    softs[ok ? "passed" : "failed"]++;
    return !!ok;
  };

  /** Hard check: the last chat() started a turn whose header names the skill (its name in agent/skills). */
  const ranSkill = async (skill) => {
    const title = skillTitle(skill);
    const h = await headers();
    const last = h.at(-1);
    return check(`the header names the skill (${title})`, h.length > headersBefore && [title, skill].some((t) => last?.skill === t || !!last?.text?.endsWith(t)), last?.text ?? null);
  };

  /** Prints the summary lines and exits (1 only when a hard check failed). */
  const done = (label) => {
    // Work committed after a test must land on the branch it started on;
    // nothing in a live test should switch it (Developer mode uses its own worktree).
    const now = branch();
    if (now !== startBranch && !/^developer/.test(label.toLowerCase())) {
      check(`the repository stays on ${startBranch} (now ${now}: a turn ran in Developer mode)`, false);
    }
    if (softs.passed + softs.failed) console.log(`SOFT ${softs.passed} passed, ${softs.failed} failed`);
    console.log(failed ? `${label} TEST FAILED (${failed})` : `${label} TEST PASSED`);
    c.stop();
    process.exit(failed ? 1 : 0);
  };

  return { c, lua, chat, waitIdle, sleep, check, soft, ranSkill, done };
}
