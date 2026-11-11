// Live test of the image generator (#102) with a real agent and Codex's image generation: the panel asks before
// anything is generated, a "Deny" generates nothing, and an "Allow" brings back an image that storyboard_to_frames
// turns into a hidden reference layer and an editable pixel draft. It uses the Codex plan's limits (one image),
// so it isn't part of "all".
// Run with Aseprite open:  node agent/tests/image_gen_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, done } = await live({ provider });
const entries = () => lua(`local out, list = {}, AsepriteAgent.entries() local from = 1
  for i = #list, 1, -1 do if list[i].kind == "user" then from = i; break end end
  for i = from, #list do local e = list[i]; out[#out + 1] = e.kind .. ": " .. (e.text or "") .. " => " .. tostring(e.result or "") end return out`);
const answer = (kind) => lua(`AsepriteAgent.setPermissionAnswer(function(req)
  _G.__permissionTexts = _G.__permissionTexts or {}
  table.insert(_G.__permissionTexts, req.text or "")
  for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^${kind}") then return i end end
  return 1 end) return true`);
const asked = () => lua("return _G.__permissionTexts or {}");
const layers = () => lua(`local out = {} for _, l in ipairs(app.sprite.layers) do
  local n = 0 for _, c in ipairs(l.cels) do if not c.image:isEmpty() then n = n + 1 end end
  out[#out + 1] = { name = l.name, visible = l.isVisible, editable = l.isEditable, cels = n } end return out`);

await lua(`_G.__permissionTexts = {} local s = Sprite(48, 48) s.layers[1].name = "Art" return true`);
const PROMPT = "a small knight with a red plume, side view facing right, full body, standing, flat colors, plain white background, no text";

await answer("reject");
await chat(`Call generate_image with the prompt "${PROMPT}". If the user declines, reply only "declined" and stop.`);
let a = await asked();
check("the panel asks before generating", a.length === 1 && /image generator.*Codex plan's limits.*knight/.test(a[0]), a);
let turn = await entries();
check("a declined request generates nothing", !turn.some((l) => /Generated .*\.png/.test(l)), turn);
check("no layer was added", (await layers()).length === 1, await layers());

await answer("allow");
await chat(`Call generate_image with the prompt "${PROMPT}" (keep waiting with its job id while it is still generating). ` +
  "Then call storyboard_to_frames with that image, panels \"auto\" and draft: 12. Stop after that: no cleanup, no snapshot.",
  { timeout: 900_000 });
a = await asked();
check("asked again after the user's next message", a.length === 2, a);
turn = await entries();
check("an image came back", turn.some((l) => /Generated .*\.png \(\d+x\d+\)/.test(l)), turn);
const ls = await layers();
const ref = ls.find((l) => l.name === "AI: Reference"), draft = ls.find((l) => l.name === "AI: Draft");
check("a hidden, locked reference layer", ref && !ref.visible && !ref.editable && ref.cels >= 1, ls);
check("an editable pixel draft with art", draft && draft.visible && draft.editable && draft.cels >= 1, ls);
const colors = await lua(`local l for _, x in ipairs(app.sprite.layers) do if x.name == "AI: Draft" then l = x end end
  local seen, n = {}, 0 for it in l.cels[1].image:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 and not seen[v] then seen[v] = true n = n + 1 end end return n`);
check("the draft has at most 12 colors", colors >= 2 && colors <= 12, colors);

// A plain request for new art, with no tool named: the agent starts from an image draft by itself (basics guide).
await lua(`_G.__permissionTexts = {} return true`);
await answer("allow");
await chat("Draw a cute green slime as a 32x32 pixel-art sprite.", { timeout: 900_000 });
turn = await entries();
check("a plain 'draw a ...' starts with the image generator", turn.some((l) => /^tool: Generate an image/.test(l)), turn.filter((l) => /^tool:/.test(l)));
const ls2 = await lua(`local out = {} if app.sprite then for _, l in ipairs(app.sprite.layers) do out[#out + 1] = l.name end end return out`);
check("its draft and reference are on the sprite", ls2.includes("AI: Draft") && ls2.includes("AI: Reference"), ls2);

done("IMAGE GEN");
