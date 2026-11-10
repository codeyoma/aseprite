// Live test of Developer mode (#28), end to end: the agent changes the chat
// panel's placeholder in its own worktree on a dev/ branch while this
// checkout stays on its branch; Apply (Rebuild & Relaunch) fast-forwards the
// branch and restarts Aseprite with the change; the open sprite and the
// conversation survive and the conversation continues. Discard undoes the
// applied commits. Needs this checkout clean (commit your work first).
// Run with Aseprite open from build/bin:  node agent/tests/developer_live.mjs [claude|codex]
// It leaves a dev/ branch with the agent's commit; delete it afterwards.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const NEW_TEXT = "Ask the pixel wizard...";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const branch = () => spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const startBranch = branch();
const startSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
const devBranches = () => spawnSync("git", ["branch", "--list", "dev/*", "--sort=-committerdate", "--format=%(refname:short)"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

const { c, lua, chat, sleep, check, done } = await live({ provider });
const answers = `AsepriteAgent.setDeveloperAnswers(function() return true end)
  AsepriteAgent.setPermissionAnswer(function(req)
    for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
    return 1
  end)`;

// An unsaved sprite that must survive the relaunch.
await lua(`local s = Sprite(16, 16, ColorMode.RGB)
  app.useTool{ tool = "pencil", color = Color(0, 200, 0), points = { Point(5, 6) } }
  ${answers} return true`);
const before = await lua("return AsepriteAgent.placeholder()");

await chat(
  `Change the chat input's placeholder (PLACEHOLDER in agent/extension/chat_panel.lua) to "${NEW_TEXT}" and commit it. Only that change.`,
  { mode: "developer" },
);
check("this checkout stays on its branch", branch() === startBranch, branch());
const devBranch = devBranches()[0] ?? "";
const grep = spawnSync("git", ["grep", "-c", NEW_TEXT, devBranch, "--", "agent/extension/chat_panel.lua"], { cwd: repo, encoding: "utf8" });
check("the agent committed the change on its dev/ branch", devBranch.startsWith("dev/") && grep.status === 0, { devBranch, out: grep.stdout });
check("the checkout's files are untouched", spawnSync("git", ["grep", "-q", NEW_TEXT, "--", "agent/extension/chat_panel.lua"], { cwd: repo }).status !== 0);
check("not loaded before applying", (await lua("return AsepriteAgent.placeholder()")) === before);

// Apply: only Lua changed, so this relaunches without a build.
const tracked = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).stdout.trim();
check("this checkout has no uncommitted changes (Apply needs that)", !tracked, tracked);
await lua("return AsepriteAgent.applyDevChanges()");
await sleep(5000); // Aseprite quits; the bridge starts it again
for (let t = 0; t < 30 && (await c.call("get_state")).isError; t++) await sleep(2000);
await sleep(3000);
await lua(`${answers} return true`);
check("the change is live after the relaunch", (await lua("return AsepriteAgent.placeholder()")) === NEW_TEXT);
check("applying moved this checkout's branch to the agent's commit", branch() === startBranch && spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim() !== startSha);
const px = await lua(`local s = app.sprite if not s then return nil end
  local img = Image(s.width, s.height, ColorMode.RGB); img:drawSprite(s, 1)
  return app.pixelColor.rgbaG(img:getPixel(5, 6))`);
check("the unsaved sprite came back", px === 200, px);
const entries = await lua("return AsepriteAgent.entries()");
check("the conversation came back", entries.some((e) => e.kind === "user") && entries.at(-1)?.text?.startsWith("Aseprite restarted"), entries.at(-1));

await chat("What exact text did you set the placeholder to? Reply with the text only.", { mode: "developer" });
const last = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").at(-1)?.text ?? "";
check("the conversation continues", last.includes("pixel wizard"), last);

await lua("return AsepriteAgent.discardDevChanges()");
await sleep(2000);
const now = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
check("discard undoes the applied commits", branch() === startBranch && now === startSha, { branch: branch(), now, startSha });

console.log(`(dev branch left for inspection: ${devBranch})`);
done("DEVELOPER");
