// Shared harness for the live tests (agent/tests/*_live.mjs): a bridge
// connected to the running Aseprite, Lua through execute_lua, chat turns
// through the panel's AsepriteAgent API, and PASS/FAIL reporting.
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * provider: the chat provider for chat() ("claude" or "codex").
 * Returns { c, lua, chat, waitIdle, sleep, check, done }.
 */
export async function live({ provider = "claude", bridge = {} } = {}) {
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
    console.log(failed ? `${label} TEST FAILED (${failed})` : `${label} TEST PASSED`);
    c.stop();
    process.exit(failed ? 1 : 0);
  };

  return { c, lua, chat, waitIdle, sleep, check, done };
}
