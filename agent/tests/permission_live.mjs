// Live test of the panel's permission round trip (#31, #55) with a scripted
// ACP agent (agent/bridge/test/helpers/fake_acp_agent.mjs) in place of
// Claude or Codex, so it runs the same way every time and costs nothing:
// the agent asks to run a command, the panel shows the request, the answer
// goes back, and the agent reports what it was told. (Stop with a request
// pending is in the bridge's acp_permission test: unanswered, the panel
// shows a modal dialog.)
// Run with Aseprite open:  node agent/tests/permission_live.mjs
import { fileURLToPath } from "node:url";
import { live } from "./live.mjs";

const agent = fileURLToPath(new URL("../bridge/test/helpers/fake_acp_agent.mjs", import.meta.url));
const { lua, chat, check, done } = await live({ provider: "claude", bridge: { env: { ASEPRITE_AGENT_ACP_AGENT: agent, ASEPRITE_AGENT_RUNTIME: "" } } });
const lastTurn = () => lua(`local out, list = {}, AsepriteAgent.entries() local from = 1
  for i = #list, 1, -1 do if list[i].kind == "user" then from = i; break end end
  for i = from, #list do local e = list[i]; out[#out + 1] = e.kind .. ": " .. (e.text or "") end return out`);
const answer = (kind) => lua(`AsepriteAgent.setPermissionAnswer(function(req)
  for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^${kind}") then return i end end
  return 1 end) return true`);

await lua("Sprite(8, 8) return true");
await answer("allow");
await chat("run the command", { mode: "agent" });
let turn = await lastTurn();
check("the request shows in the panel", turn.some((l) => /^status: Permission for touch \/tmp\/fake-acp-file/.test(l)), turn);
check("allow reaches the agent", turn.some((l) => l === "text: permission: allow-once"), turn);

await answer("reject");
await chat("run it again", { mode: "agent" });
turn = await lastTurn();
check("reject reaches the agent", turn.some((l) => l === "text: permission: reject-once"), turn);

// The user's default: no dialog, the request is allowed and the log says so.
await lua("AsepriteAgent.setAskPermissions(false) AsepriteAgent.setPermissionAnswer(function() error('asked') end) return true");
await chat("run the command once more", { mode: "agent" });
turn = await lastTurn();
check("asking off: allowed without a dialog", turn.some((l) => /^text: permission: allow/.test(l)), turn);
check("asking off: the log says it was allowed automatically", turn.some((l) => /allowed automatically/.test(l)), turn);
await lua("AsepriteAgent.setAskPermissions(true) return true");

done("PERMISSION");
