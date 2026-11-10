// Live test of the ACP runtime (#31) through the chat panel:
//  1. Stop mid-turn, then a next message continues the same session.
//  2. A permission request from the agent reaches the panel and is answered.
//     Agents that approve on their own (Codex auto-review, Claude with only
//     the aseprite tools) never ask, so this step can fail without a bug.
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
await chat("Remember the word PINEAPPLE. Then call get_state, then read every guide topic one by one, then describe them at length.", { mode: null, wait: false });
await sleep(8000);
await lua("AsepriteAgent.stop() return true");
await waitIdle(60_000);
turn = await lastTurn();
check("stop ends the turn", turn.some((l) => l === "status: Stopped."), turn);

await chat("What word did I ask you to remember? Answer with the word only.", { mode: null });
turn = await lastTurn();
check("next message continues the session", turn.some((l) => /pineapple/i.test(l) && l.startsWith("text")), turn);

}
// 2. Permission: answer with the first "allow" option.
await lua(`AsepriteAgent.setPermissionAnswer(function(req)
  for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
  return 1
end) return true`);
await chat("Use your shell to run exactly: touch ~/aseprite-acp-permission-test . Then say done.", { mode: null });
turn = await lastTurn();
console.log(turn.join("\n"));
const asked = turn.find((l) => l.startsWith("status: Permission for"));
check("permission request shown and answered", !!asked, turn);
await lua("AsepriteAgent.setPermissionAnswer(nil) return true");

done("ACP");
