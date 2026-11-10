// Live test of FX export (#71), through the tools only (no model): the FX record on the effect layer,
// one undo step, and export_for_engine's pivot, meta.fx and glow sheet in Aseprite.
// Run with Aseprite open:  node agent/tests/fx_export_live.mjs <dir>
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "fx-export-"));
const { c, lua, check, done } = await live({ provider: "claude" });
const text = (r) => r.content?.[0]?.text ?? "";
const state = async () => JSON.parse(text(await c.call("get_state"))).activeSprite;

// 1. add_fx records the effect on its layer; one undo removes both.
await lua(`local s = Sprite(64, 64, ColorMode.RGB) s.layers[1].name = "Hero" return true`);
await c.call("add_fx", { id: "hit-spark", x: 32, y: 32, glow: "layer" });
let s = await state();
const fxLayer = s.layers.find((l) => l.name === "AI: fx hit-spark");
check("add_fx records the effect on its layer", fxLayer?.fx?.id === "hit-spark" && Number.isInteger(fxLayer.fx.x), fxLayer?.fx);
await lua(`app.command.Undo() return true`);
s = await state();
check("one undo removes the effect and its record", !s.layers.some((l) => l.name.startsWith("AI: fx")), s.layers.map((l) => l.name));
await lua(`app.sprite:close() return true`);

// 2. new_fx_sprite makes its own tagged sprite.
const made = text(await c.call("new_fx_sprite", { id: "small-explosion", fps: 30 }));
check("new_fx_sprite made a sprite", /Made "/.test(made), made);
await lua(`app.sprite:close() return true`);

// 3. A sprite of effect layers only exports with the effect origin as pivot, meta.fx and a glow sheet.
await lua(`local s = Sprite(96, 96, ColorMode.RGB) s.layers[1].isVisible = false return true`);
await c.call("add_fx", { id: "small-explosion", x: 48, y: 80, anchor: "ground", glow: "layer" });
for (const engine of ["phaser", "godot", "json"]) {
  const out = join(dir, engine);
  const r = await c.call("export_for_engine", { engine, dir: out, name: "boom" });
  check(`${engine}: export succeeded`, !r.isError, text(r).slice(0, 300));
  const jsonFile = readdirSync(out).find((f) => f.endsWith(".json"));
  const j = jsonFile ? JSON.parse(readFileSync(join(out, jsonFile), "utf8")) : {};
  check(`${engine}: meta.fx with fps and loop`, j.meta?.fx?.fps === 30 && j.meta.fx.loop === false, j.meta?.fx);
  if (engine === "phaser") {
    const frames = Array.isArray(j.frames) ? j.frames : Object.values(j.frames ?? {});
    check("phaser: frames carry the effect origin as pivot", frames.length > 0 && frames.every((f) => f.pivot && f.pivot.y > 0.5), frames[0]?.pivot);
  }
  if (engine === "godot") check("godot: glow sheet and resource", existsSync(join(out, "boom_glow.png")) && readdirSync(out).some((f) => f.endsWith("_glow.tres")), readdirSync(out));
}
await lua(`app.sprite:close() return true`);
done("FX export");
