// Live test of the in-app chat: sends a prompt through the extension's
// chat panel (AsepriteAgent.chat), which asks this bridge to run the agent
// CLI. Waits for the agent to finish and prints the panel log.
// Run with Aseprite open:  node agent/tests/chat_live.mjs [claude|codex] "prompt"
import { live } from "./live.mjs";
import { textOf } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const prompt =
  process.argv[3] ??
  "Create a new 16x16 sprite with one layer named Gem and draw a small green diamond in the middle of it.";

const { c, lua, chat, waitIdle } = await live({ provider });

const started = Date.now();
await chat(prompt, { mode: null, wait: false });
let busy = false;
await waitIdle(300_000, 3000).catch(() => (busy = true));
const entries = await lua(`
  local out = {}
  for _, e in ipairs(AsepriteAgent.entries()) do
    out[#out + 1] = e.kind .. (e.status and ("[" .. e.status .. "]") or "") .. ": " .. (e.text or (e.secs and (e.secs .. "s")) or "")
  end
  return out`);
console.log(`--- panel log (${((Date.now() - started) / 1000).toFixed(0)}s) ---`);
for (const line of entries ?? []) console.log(line.length > 200 ? line.slice(0, 200) + "..." : line);
const state = JSON.parse(textOf(await c.call("get_state")));
console.log("--- active sprite:", JSON.stringify({ size: [state.activeSprite?.width, state.activeSprite?.height], layers: state.activeSprite?.layers?.map((l) => l.name) }));
// Only judge entries from this run: those after the last "user" line.
const lastUser = (entries ?? []).map((l) => l.startsWith("user")).lastIndexOf(true);
const run = (entries ?? []).slice(lastUser);
// Agents recover from a failed tool call (e.g. a too-large read); fail only on an
// error entry, a failing last step, or a run with no successful step.
const tools = run.filter((l) => l.startsWith("tool["));
const failed = busy || run.some((l) => l.startsWith("error")) || !tools.some((l) => l.startsWith("tool[ok]")) ||
  (tools.length > 0 && tools.at(-1).startsWith("tool[failed]"));
console.log(failed ? "CHAT TEST FAILED" : "CHAT TEST PASSED");
c.stop();
process.exit(failed ? 1 : 0);
