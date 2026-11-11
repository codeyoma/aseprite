// Live test of parallel sub-agents (#33): "shade all 8 frames" with 4
// sub-agents versus one agent, the panel log, and the timeline highlight.
// Run with Aseprite open:  node agent/tests/subagents_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat: send, sleep, check, soft, done } = await live({ provider });
// Timeline range lengths seen while a turn runs (the agent cursor).
const ranges = [];
async function chat(prompt) {
  const t0 = Date.now();
  await send(prompt, { wait: false });
  while (Date.now() - t0 < 900_000) {
    await sleep(1500);
    ranges.push(await lua("local c = AsepriteAgent.agentCursor() return { range = #app.range.frames, cursor = c }"));
    if (!(await lua("return AsepriteAgent.isBusy()"))) return Math.round((Date.now() - t0) / 1000);
  }
  throw new Error("turn did not end");
}
const fixture = `local s = Sprite(32, 32, ColorMode.RGB); for i = 1, 7 do s:newFrame() end
  s.layers[1].name = "Body"
  for f = 1, 8 do
    local img = Image(32, 32, ColorMode.RGB)
    for y = 0, 31 do for x = 0, 31 do
      if (x - 16 - (f - 4)) ^ 2 + (y - 16) ^ 2 <= 64 then img:drawPixel(x, y, Color(80, 160, 230)) end
    end end
    s.layers[1]:cel(f).image = img
  end
  return true`;
// Frames whose pixels changed from the fixture.
const changedFrames = () => lua(`local s = app.sprite local n = 0
  for f = 1, 8 do
    local img = s.layers[1]:cel(f).image
    local changed = false
    for it in img:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 and v ~= app.pixelColor.rgba(80, 160, 230, 255) then changed = true break end end
    for _, l in ipairs(s.layers) do if l ~= s.layers[1] and l:cel(f) and not l:cel(f).image:isEmpty() then changed = true end end
    if changed then n = n + 1 end
  end
  return n`);
// Each frame needs its own drawing, so the work is the agents' output, not setup.
const TASK = "Inside the blue circle of each of the 8 frames, draw a different small pixel-art face (about 10x10 px) on the " +
  "Body layer: frame 1 happy, 2 sad, 3 surprised, 4 angry, 5 sleepy, 6 winking, 7 laughing, 8 confused, each with eyes, " +
  "brows and mouth and a darker blue shade on the circle's lower-right. Skip the check and don't take snapshots.";

await lua(fixture);
const parallel = await chat(`${TASK} Use spawn_agents with 4 sub-agents of 2 frames each.`);
check("all 8 frames shaded (parallel)", (await changedFrames()) === 8, await changedFrames());
const entries = await lua("return AsepriteAgent.entries()");
console.log("spawn_agents result:", entries.filter((e) => e.kind === "tool" && /sub-agents/.test(e.text ?? "")).map((e) => e.result).join("\n"));
// A sub-agent's steps start with its label: "frames 1-2" by default, or the label the agent gave the task.
const subSteps = entries.filter((e) => e.kind === "tool" && /^\[[^\]]+\] /.test(e.text ?? ""));
// The model may ignore "use spawn_agents" (Codex sometimes does the frames itself): that is soft; when it did spawn
// them, their steps must show in the log.
const spawned = entries.some((e) => e.kind === "tool" && /sub-agents/.test(e.text ?? ""));
soft("the agent used spawn_agents", spawned);
if (spawned) check("the log shows sub-agents and their steps", new Set(subSteps.map((e) => e.text.match(/^\[(.*?)\]/)[1])).size >= 4, subSteps.map((e) => e.text));
if (spawned) check("the timeline highlighted a sub-agent's frames while it worked",
  ranges.some((r) => r.range === 2 || r.cursor?.set === 2), ranges.slice(-6));

await lua(fixture);
const single = await chat(`${TASK} Do it yourself frame by frame, one execute_lua call per frame; don't use spawn_agents.`);
check("all 8 frames shaded (one agent)", (await changedFrames()) === 8, await changedFrames());
console.log(`parallel ${parallel}s, one agent ${single}s`);
soft("parallel is faster", parallel < single, { parallel, single });

done("SUBAGENTS");
