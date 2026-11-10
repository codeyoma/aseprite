// Live test of Developer mode (#28), end to end: the agent changes the chat
// panel's placeholder on a dev/ branch, Rebuild & Relaunch restarts
// Aseprite with the change, the open sprite and the conversation survive,
// and the conversation continues. Discard returns to the original branch.
// Run with Aseprite open from build/bin:  node agent/tests/developer_live.mjs [claude|codex]
// It leaves a dev/ branch with the agent's commit; delete it afterwards.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const NEW_TEXT = "Ask the pixel wizard...";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const branch = () => spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const startBranch = branch();

const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdle(limit = 600_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    await sleep(3000);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
  throw new Error("turn did not end");
}
const answers = `AsepriteAgent.setDeveloperAnswers(function() return true end)
  AsepriteAgent.setPermissionAnswer(function(req)
    for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
    return 1
  end)`;
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// An unsaved sprite that must survive the relaunch.
await lua(`local s = Sprite(16, 16, ColorMode.RGB)
  app.useTool{ tool = "pencil", color = Color(0, 200, 0), points = { Point(5, 6) } }
  ${answers} return true`);
const before = await lua("return AsepriteAgent.placeholder()");

await lua(`AsepriteAgent.chat(${JSON.stringify(
  `Change the chat input's placeholder (PLACEHOLDER in agent/extension/chat_panel.lua) to "${NEW_TEXT}" and commit it. Only that change.`,
)}, "${provider}", "developer") return true`);
await waitIdle();
const devBranch = branch();
check("the agent works on a dev/ branch", devBranch.startsWith("dev/"), devBranch);
const grep = spawnSync("git", ["grep", "-c", NEW_TEXT, "HEAD", "--", "agent/extension/chat_panel.lua"], { cwd: repo, encoding: "utf8" });
check("the change is committed on it", grep.status === 0, grep.stdout);
check("not loaded before relaunch", (await lua("return AsepriteAgent.placeholder()")) === before);

// Apply: only Lua changed, so this relaunches without a build.
await lua("return AsepriteAgent.applyDevChanges()");
await sleep(5000); // Aseprite quits; the bridge starts it again
for (let t = 0; t < 30 && (await c.call("get_state")).isError; t++) await sleep(2000);
await sleep(3000);
await lua(`${answers} return true`);
check("the change is live after the relaunch", (await lua("return AsepriteAgent.placeholder()")) === NEW_TEXT);
const px = await lua(`local s = app.sprite if not s then return nil end
  local img = Image(s.width, s.height, ColorMode.RGB); img:drawSprite(s, 1)
  return app.pixelColor.rgbaG(img:getPixel(5, 6))`);
check("the unsaved sprite came back", px === 200, px);
const entries = await lua("return AsepriteAgent.entries()");
check("the conversation came back", entries.some((e) => e.kind === "user") && entries.at(-1)?.text?.startsWith("Aseprite restarted"), entries.at(-1));

await lua(`AsepriteAgent.chat("What exact text did you set the placeholder to? Reply with the text only.", "${provider}", "developer") return true`);
await waitIdle();
const last = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").at(-1)?.text ?? "";
check("the conversation continues", last.includes("pixel wizard"), last);

await lua("return AsepriteAgent.discardDevChanges()");
await sleep(2000);
check("discard returns to the original branch", branch() === startBranch, branch());

console.log(failed ? `DEVELOPER TEST FAILED (${failed})` : "DEVELOPER TEST PASSED");
console.log(`(dev branch left for inspection: ${devBranch})`);
process.exit(failed ? 1 : 0);
