// Live test of FX recipes and check_fx (#72), through the tools only (no model).
// Run with Aseprite open:  node agent/tests/fx_recipe_live.mjs
import { live } from "./live.mjs";

const { c, lua, check, done } = await live({ provider: "claude" });
const text = (r) => r.content?.[0]?.text ?? "";
const state = async () => JSON.parse(text(await c.call("get_state"))).activeSprite;
const recipe = { name: "blue-burst", size: [96, 96], origin: [48, 48], duration: 0.6,
  palette: ["#10162e", "#2a4a8c", "#4f8fe0", "#9fd4ff", "#ffffff"],
  phases: [
    { name: "flash", start: 0, end: 0.1, shapes: [{ type: "disc", radius: [6, 2], color: -1 }] },
    { name: "burst", start: 0, end: 0.4,
      emitters: [{ kind: "spark", count: 16, speed: [80, 160], life: [0.2, 0.35] }],
      rings: [{ radius: [3, 22], width: [3, 1], color: "cool" }],
      lights: [{ radius: 24, strength: 0.6, life: 0.25 }] }] };

await lua(`local s = Sprite(96, 96, ColorMode.RGB) s.layers[1].name = "Hero" return true`);
const bad = await c.call("fx_from_recipe", { recipe: { ...recipe, phases: [{ name: "burst", start: 0, end: 1, emitters: [{ kind: "spark", count: 9999 }] }] }, apply: "preview" });
check("a bad recipe is refused with its path", bad.isError && /count/.test(text(bad)), text(bad).slice(0, 200));
const pv = await c.call("fx_from_recipe", { recipe, apply: "preview" });
check("preview returns an image", !pv.isError && pv.content.some((x) => x.type === "image"), text(pv).slice(0, 200));
const r = await c.call("fx_from_recipe", { recipe, apply: "layer", x: 48, y: 48, glow: "layer" });
check("apply layer succeeded", !r.isError, text(r).slice(0, 300));
let s = await state();
const l = s.layers.find((x) => x.fx?.id === "recipe:blue-burst");
check("the layer records the recipe", !!l && typeof l.fx.recipe === "string" && l.fx.recipe.includes("blue-burst"), l?.fx);
check("the glow layer is Addition", s.layers.some((x) => /glow/.test(x.name) && /addition/i.test(String(x.blendMode))), s.layers.map((x) => [x.name, x.blendMode]));
const k = text(await c.call("check_fx", {}));
check("check_fx finds no errors on a placed recipe", !/\berror\b/i.test(k.split("\n").slice(1).join("\n")) || /\b0 errors\b/.test(k), k.slice(0, 400));
await lua(`app.command.Undo() return true`);
s = await state();
check("one undo removes the recipe effect", !s.layers.some((x) => x.name.startsWith("AI: fx")), s.layers.map((x) => x.name));
// Placed at the corner, the effect spills off the canvas.
await c.call("fx_from_recipe", { recipe, apply: "layer", x: 2, y: 2, glow: "none" });
const k2 = text(await c.call("check_fx", {}));
check("check_fx reports a spill at the edge", /spill/i.test(k2), k2.slice(0, 400));
await lua(`app.sprite:close() return true`);
const sp = await c.call("fx_from_recipe", { recipe: { ...recipe, name: "blue-loop", loop: true, duration: 1 }, apply: "sprite" });
check("apply sprite makes a sprite", !sp.isError, text(sp).slice(0, 200));
const k3 = text(await c.call("check_fx", {}));
check("the looping recipe has no seam", !/seam/i.test(k3), k3.slice(0, 400));
await lua(`app.sprite:close() return true`);
done("FX recipe");
