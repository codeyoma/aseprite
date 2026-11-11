// Live test of layered characters (#103) with a real agent and Codex's image generation: one consent for the whole
// batch, a master sheet and one image per part layer, and the parts landing in a group on the key frames with the
// master as a hidden reference. It uses the Codex plan's limits (about 9 images), so it isn't part of "all".
// Run with Aseprite open:  node agent/tests/layered_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, done } = await live({ provider });
await lua(`_G.__permissionTexts = {}
  AsepriteAgent.setPermissionAnswer(function(req)
    table.insert(_G.__permissionTexts, req.text or "")
    for i, o in ipairs(req.options or {}) do if tostring(o.kind):match("^allow") then return i end end
    return 1 end)
  local s = Sprite(48, 48) for i = 1, 5 do s:newFrame() end
  local t = s:newTag(1, 6) t.name = "walk"
  return true`);

await chat("Call generate_character for a small knight with a red plume, steel armor and a blue tunic: name Knight, " +
  "tag walk, frames [1, 4], poses ['contact: near leg forward, near arm back', 'contact: near leg back, near arm forward'], " +
  "default layers, 16 colors. Keep calling it with the job id until it is done. Then stop: no cleanup.", { timeout: 1_500_000 });

const asked = await lua("return _G.__permissionTexts");
check("one consent for the batch", asked.length === 1 && /9 images \(1 master sheet \+ 8 layers/.test(asked[0]), asked);
const layers = await lua(`local out = {}
  local function walk(ls, parent) for _, l in ipairs(ls) do
    local n = 0 if not l.isGroup then for _, c in ipairs(l.cels) do if not c.image:isEmpty() then n = n + 1 end end end
    out[#out + 1] = { name = l.name, parent = parent, group = l.isGroup, visible = l.isVisible, editable = l.isEditable, cels = n }
    if l.isGroup then walk(l.layers, l.name) end end end
  walk(app.sprite.layers, "") return out`);
const parts = layers.filter((l) => l.parent === "AI: Knight");
check("a group 'AI: Knight' with the part layers", parts.length >= 6, layers.map((l) => `${l.parent}/${l.name}:${l.cels}`));
check("near arm and near leg are among them", parts.some((l) => l.name === "near arm") && parts.some((l) => l.name === "near leg"), parts.map((l) => l.name));
check("parts have art on the two key frames", parts.filter((l) => l.cels >= 2).length >= 5, parts.map((l) => `${l.name}:${l.cels}`));
const ref = layers.find((l) => l.name === "AI: Reference");
check("the master is a hidden, locked reference", ref && !ref.visible && !ref.editable && ref.cels === 2, ref);
const spec = await lua(`return app.sprite.properties("aseprite-agent")["concept.spec"]`);
check("the motion stage starts at keys 1 and 4", /"stage":\s*"keys"/.test(spec) && /"keys":\s*\[1,\s*4\]/.test(spec), spec);

done("LAYERED");
