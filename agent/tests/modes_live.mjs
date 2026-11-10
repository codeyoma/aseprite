// Live test of chat modes (#24) through the chat panel:
//  1. Ask mode: "make it blue" leaves the sprite unchanged.
//  2. Plan mode: a plan, no changes; then Apply plan carries it out.
// Run with Aseprite open:  node agent/tests/modes_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, waitIdle, check, done } = await live({ provider });
const fingerprint = () =>
  lua(`local s = app.sprite
    local img = Image(s.width, s.height, ColorMode.RGB); img:drawSprite(s, 1)
    local n = 0 for it in img:pixels() do n = (n * 31 + it()) % 2147483647 end
    return { layers = #s.layers, hash = n }`);

await lua(`local s = Sprite(16, 16, ColorMode.RGB)
  app.useTool{ tool = "filled_rectangle", color = Color(255, 0, 0), points = { Point(4, 4), Point(11, 11) } }
  return true`);
const before = await fingerprint();

await chat("Make the red square blue.", { mode: "ask" });
check("ask mode leaves the sprite unchanged", JSON.stringify(await fingerprint()) === JSON.stringify(before));

await chat("Add a new layer named Outline with a 1px black outline around the square.", { mode: "plan" });
check("plan mode leaves the sprite unchanged", JSON.stringify(await fingerprint()) === JSON.stringify(before));
const entries = await lua("return AsepriteAgent.entries()");
const planText = entries.filter((e) => e.kind === "text").map((e) => e.text).at(-1) ?? "";
check("reply is a numbered plan", /(^|\n)\s*1[.)]/.test(planText), planText.slice(0, 200));
check("Apply plan offered", entries.at(-1)?.applyPlan === true, entries.at(-1));

await lua("return AsepriteAgent.applyPlan()");
await waitIdle();
const after = await fingerprint();
const names = await lua(`local o = {} for _, l in ipairs(app.sprite.layers) do o[#o + 1] = l.name end return o`);
check("Apply plan carried it out", names.includes("Outline") && after.hash !== before.hash, names);

done("MODES");
