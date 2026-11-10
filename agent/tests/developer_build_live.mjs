// Live test of Developer mode's C++ path (#28): a broken C++ file makes
// Rebuild & Relaunch fail, the errors go to the agent, the agent fixes
// them, and the next Rebuild & Relaunch builds and restarts Aseprite.
// Setup: on a dev/ branch (base recorded in git config) with a C++ syntax
// error in src/app/cmd.cpp. Run with Aseprite open from build/bin.
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, sleep, check, done } = await live({ provider });
const answers = `AsepriteAgent.setDeveloperAnswers(function() return true end)
  AsepriteAgent.setPermissionAnswer(function(req)
    for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
    return 1
  end)`;
const entries = () => lua("return AsepriteAgent.entries()");

await lua(`${answers} AsepriteAgent.applyDevChanges() return true`);
// Build fails; the panel sends the errors to the agent, which fixes them.
let sawError = false, sawTurn = false;
for (let t = 0; t < 400; t++) {
  await sleep(3000);
  const list = await entries();
  sawError ||= list.some((e) => e.kind === "error" && e.text?.startsWith("Build failed"));
  const busy = await lua("return AsepriteAgent.isBusy()");
  sawTurn ||= busy;
  if (sawError && sawTurn && !busy) break;
}
check("the failed build is shown", sawError);
check("the errors went to the agent", (await entries()).some((e) => e.kind === "user" && e.text?.startsWith("The build failed")));

await lua(`${answers} AsepriteAgent.applyDevChanges() return true`);
// Build succeeds, Aseprite quits and the bridge starts it again; the
// restored conversation ends with "Aseprite restarted..." (requests wait
// for Aseprite to reconnect, so the gap itself is not observable).
let last;
for (let t = 0; t < 300; t++) {
  await sleep(3000);
  last = (await entries()).at(-1);
  if (last?.text?.startsWith("Aseprite restarted")) break;
}
check("the fixed build relaunched Aseprite with the conversation", last?.text?.startsWith("Aseprite restarted"), last);
done("DEVELOPER BUILD");
