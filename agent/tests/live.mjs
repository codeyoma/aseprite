// Shared harness for the live tests (agent/tests/*_live.mjs): a bridge
// connected to the running Aseprite, Lua through execute_lua, chat turns
// through the panel's AsepriteAgent API, and PASS/FAIL reporting.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

/**
 * provider: the chat provider for chat() ("claude" or "codex").
 * Returns { c, lua, chat, waitIdle, sleep, check, done }.
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

  /** Sends a chat message as the user would; mode null uses the panel's current mode. */
  const chat = async (prompt, { mode = "agent", wait = true, timeout, as = provider } = {}) => {
    const args = [JSON.stringify(prompt), JSON.stringify(as), ...(mode ? [JSON.stringify(mode)] : [])];
    await lua(`AsepriteAgent.chat(${args.join(", ")}) return true`);
    return wait ? waitIdle(timeout) : undefined;
  };

  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
    if (!ok) failed++;
    return ok;
  };

  /** Prints the summary line and exits (1 when a check failed). */
  const done = (label) => {
    // A Developer mode turn switches the repository to a dev/ branch; work
    // committed afterwards would land there. Only developer tests may.
    const now = branch();
    if (now !== startBranch && !/^developer/.test(label.toLowerCase())) {
      check(`the repository stays on ${startBranch} (now ${now}: a turn ran in Developer mode)`, false);
    }
    console.log(failed ? `${label} TEST FAILED (${failed})` : `${label} TEST PASSED`);
    c.stop();
    process.exit(failed ? 1 : 0);
  };

  return { c, lua, chat, waitIdle, sleep, check, done };
}
