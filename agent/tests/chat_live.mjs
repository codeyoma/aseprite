// Live test of the in-app chat: sends a prompt through the extension's
// chat panel (AsepriteAgent.chat), which asks this bridge to run the agent
// CLI. Waits for the agent to finish and prints the panel log.
// Run with Aseprite open:  node agent/tests/chat_live.mjs [claude|codex] "prompt"
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const prompt =
  process.argv[3] ??
  "Create a new 16x16 sprite with one layer named Gem and draw a small green diamond in the middle of it.";

const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};

await lua(`AsepriteAgent.chat(${JSON.stringify(prompt)}, ${JSON.stringify(provider)}) return true`);
const started = Date.now();
let busy = true;
while (busy && Date.now() - started < 300_000) {
  await new Promise((r) => setTimeout(r, 3000));
  busy = await lua("return AsepriteAgent.isBusy()");
}
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
const failed = busy || run.some((l) => l.startsWith("error") || l.startsWith("tool[failed]")) || !run.some((l) => l.startsWith("tool[ok]"));
console.log(failed ? "CHAT TEST FAILED" : "CHAT TEST PASSED");
c.stop();
process.exit(failed ? 1 : 0);
