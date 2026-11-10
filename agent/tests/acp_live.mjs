// Live test of the ACP runtime (#31) through the chat panel:
//  1. Stop mid-turn, then a next message continues the same session.
//  2. The agent uses its shell in Agent mode. Claude asks permission for
//     commands that change things (answered "allow" here; read-only ones
//     like ls run on their own); Codex runs it in its sandbox with
//     its own approvals, so it may not ask. The panel's permission round
//     trip itself is tested with a scripted agent in permission_live.mjs.
// Run with Aseprite open:  node agent/tests/acp_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "codex";
const { lua, chat, waitIdle, sleep, check, done } = await live({ provider });
const lastTurn = () =>
  lua(`
  local out, list = {}, AsepriteAgent.entries()
  local from = 1
  for i = #list, 1, -1 do if list[i].kind == "user" then from = i; break end end
  for i = from, #list do local e = list[i]; out[#out + 1] = e.kind .. ": " .. (e.text or "") end
  return out`);


let turn;
// ONLY_PERMISSION=1 skips the Stop test.
if (!process.env.ONLY_PERMISSION) {
// 1. Stop, then continue.
await chat("Remember the word PINEAPPLE. Then call get_state, then read every guide topic one by one, then describe them at length.", { mode: "agent", wait: false });
await sleep(8000);
await lua("AsepriteAgent.stop() return true");
await waitIdle(60_000);
turn = await lastTurn();
check("stop ends the turn", turn.some((l) => l === "status: Stopped."), turn);

await chat("What word did I ask you to remember? Answer with the word only.", { mode: "agent" });
turn = await lastTurn();
check("next message continues the session", turn.some((l) => /pineapple/i.test(l) && l.startsWith("text")), turn);

}
// 2. Permission: answer with the first "allow" option.
await lua(`AsepriteAgent.setPermissionAnswer(function(req)
  for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
  return 1
end) return true`);
const { existsSync, mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const shellDir = mkdtempSync(join(tmpdir(), "acp-shell-"));
for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(shellDir, `${n}.png`), "");
await chat(`Use your shell to count the .png files in ${shellDir} (for example with ls). Reply with just the number.`, { mode: "agent" });
turn = await lastTurn();
console.log(turn.join("\n"));
check("the agent used its shell and got the count", turn.some((l) => l.startsWith("tool")) && turn.some((l) => /^text: .*\b5\b/.test(l)), turn);
// A command that changes files asks first (Claude Code runs read-only ones like ls on its own).
if (provider === "claude") {
  await chat(`Use your shell to create an empty file named done.txt in ${shellDir}. Then say ok.`, { mode: "agent" });
  turn = await lastTurn();
  check("Claude asked permission for a command that writes", turn.some((l) => l.startsWith("status: Permission for")), turn);
  check("the allowed command ran", existsSync(join(shellDir, "done.txt")));
}
await lua("AsepriteAgent.setPermissionAnswer(nil) return true");

done("ACP");
