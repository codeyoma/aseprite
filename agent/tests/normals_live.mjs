// Live test of Normal maps and lighting (#47).
// Run with Aseprite open:  node agent/tests/normals_live.mjs <export dir> [claude|codex]
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { c, lua, chat, check, soft, ranSkill, done } = await live({ provider });
await lua(`local s = Sprite(24, 24, ColorMode.RGB) s.layers[1].name = "Orb" s:newFrame()
  for f = 1, 2 do local img = Image(24, 24, ColorMode.RGB)
    for y = 0, 23 do for x = 0, 23 do if (x - 11.5) ^ 2 + (y - 11.5) ^ 2 < 100 then img:drawPixel(x, y, Color(200, 120, 60)) end end end
    s.layers[1]:cel(f).image = img end return true`);
await chat(`/skill:normal-map Make a normal map for the Orb for Godot, check it under a light, and export the sheets to ${dir} as orb.`);
await ranSkill("normal-map");
const s = await lua(`local s = app.sprite local nl
  for _, l in ipairs(s.layers) do if l.name:match("normal") then nl = l end end
  if not nl or not nl:cel(1) then return { ok = false } end
  local c = nl:cel(1) local function g(x, y) local p = c.image:getPixel(x - c.position.x, y - c.position.y) return { app.pixelColor.rgbaR(p), app.pixelColor.rgbaG(p) } end
  return { ok = true, name = nl.name, visible = nl.isVisible, frames = nl:cel(2) ~= nil, top = g(11, 3), right = g(20, 11) }`);
check("a normal layer for both frames", s.ok && s.frames, s);
check("normals point outward (green up at the top, red at the right)", s.ok && s.top[1] > 128 && s.right[0] > 128, s);
soft("normals tilt clearly at the edges (> 160)", s.ok && s.top[1] > 160 && s.right[0] > 160, s);
check("the normal layer is hidden", s.ok && s.visible === false, s);
const files = existsSync(dir) ? readdirSync(dir) : [];
check("color and normal sheets exported", files.some((f) => f.endsWith("_n.png")) && files.some((f) => f.endsWith(".png") && !/_[nes]\.png$/.test(f)), files);
soft("the sheets are named orb", existsSync(join(dir, "orb.png")) && existsSync(join(dir, "orb_n.png")), files);
const e = await lua("return AsepriteAgent.entries()");
soft("it previewed the lighting", e.some((x) => x.kind === "tool" && /Preview lighting/.test(x.text ?? "")), e.filter((x) => x.kind === "tool").map((x) => x.text));
done("NORMALS");
