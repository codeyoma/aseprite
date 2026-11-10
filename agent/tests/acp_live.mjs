// Live test of the ACP runtime (#31) through the chat panel:
//  1. Stop mid-turn, then a next message continues the same session.
//  2. A permission request from the agent reaches the panel and is answered.
//     Agents that approve on their own (Codex auto-review, Claude with only
//     the aseprite tools) never ask, so this step can fail without a bug.
// Run with Aseprite open:  node agent/tests/acp_live.mjs [claude|codex]
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "codex";
const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(limit = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    await sleep(2000);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
  throw new Error("turn did not end");
}
const lastTurn = () =>
  lua(`
  local out, list = {}, AsepriteAgent.entries()
  local from = 1
  for i = #list, 1, -1 do if list[i].kind == "user" then from = i; break end end
  for i = from, #list do local e = list[i]; out[#out + 1] = e.kind .. ": " .. (e.text or "") end
  return out`);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

let turn;
// ONLY_PERMISSION=1 skips the Stop test.
if (!process.env.ONLY_PERMISSION) {
// 1. Stop, then continue.
await lua(`AsepriteAgent.chat("Remember the word PINEAPPLE. Then call get_state, then read every guide topic one by one, then describe them at length.", "${provider}") return true`);
await sleep(8000);
await lua("AsepriteAgent.stop() return true");
await waitIdle(60_000);
turn = await lastTurn();
check("stop ends the turn", turn.some((l) => l === "status: Stopped."), turn);

await lua(`AsepriteAgent.chat("What word did I ask you to remember? Answer with the word only.", "${provider}") return true`);
await waitIdle();
turn = await lastTurn();
check("next message continues the session", turn.some((l) => /pineapple/i.test(l) && l.startsWith("text")), turn);

}
// 2. Permission: answer with the first "allow" option.
await lua(`AsepriteAgent.setPermissionAnswer(function(req)
  for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
  return 1
end) return true`);
await lua(`AsepriteAgent.chat("Use your shell to run exactly: touch ~/aseprite-acp-permission-test . Then say done.", "${provider}") return true`);
await waitIdle();
turn = await lastTurn();
console.log(turn.join("\n"));
const asked = turn.find((l) => l.startsWith("status: Permission for"));
check("permission request shown and answered", !!asked, turn);
await lua("AsepriteAgent.setPermissionAnswer(nil) return true");

console.log(failed ? `ACP TEST FAILED (${failed})` : "ACP TEST PASSED");
await c.close?.();
process.exit(failed ? 1 : 0);
