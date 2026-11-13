// Live test of the ComfyUI seam (#112) against a real ComfyUI server: the agent runs a saved workflow and
// imports its pose with poses_to_frames. Needs ComfyUI at the configured url and a workflow named by the
// first argument in the agent home's comfy/workflows (default fox_pose: one image param, "reference").
// Run with Aseprite open:  node agent/tests/comfy_live.mjs [claude|codex] [workflow] [reference.png]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const workflow = process.argv[3] ?? "fox_pose";
const reference = process.argv[4] ?? `${process.env.HOME}/ComfyUI-Shared/input/fox_master.png`;
const url = process.env.ASEPRITE_AGENT_COMFY_URL ?? "http://127.0.0.1:8188";
try { await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3000) }); }
catch { console.log(`SKIP no ComfyUI at ${url}`); process.exit(0); }

const { lua, chat, check, soft, done } = await live({ provider });
await lua(`local s = Sprite(64, 64, ColorMode.RGB) return true`);
await chat(`Run my ComfyUI workflow "${workflow}" with reference ${reference} and seed 7, then put the pose it makes on frame 1 of this sprite with poses_to_frames.`);
const steps = ((await lua("return AsepriteAgent.entries()")) ?? []).filter((e) => e.kind === "tool").map((e) => (e.text ?? "").slice(0, 120));
const s = await lua(`local s = app.sprite local n = 0
  for _, l in ipairs(s.layers) do local c = l:cel(1) if c then for it in c.image:pixels() do if app.pixelColor.rgbaA(it()) > 0 then n = n + 1 end end end end
  return { opaque = n, layers = #s.layers }`);
check("the pose landed on frame 1", s.opaque > 50, s);
soft("comfy_run ran", steps.some((t) => /ComfyUI|comfy/i.test(t)), steps);
soft("imported with poses_to_frames", steps.some((t) => /pose/i.test(t)), steps);
done("COMFY");
