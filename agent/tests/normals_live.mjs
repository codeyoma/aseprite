// Live test of Normal maps and lighting (#47).
// Run with Aseprite open:  node agent/tests/normals_live.mjs <export dir> [claude|codex]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const c = await startBridge();
await waitForAseprite(c);
const lua = async (code) => {
  const r = await c.call("execute_lua", { code, transaction: false });
  if (r.isError) throw new Error(textOf(r));
  const t = textOf(r);
  return t.includes("{") ? JSON.parse(t.slice(t.indexOf("{"))).value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
await lua(`local s = Sprite(24, 24, ColorMode.RGB) s.layers[1].name = "Orb" s:newFrame()
  for f = 1, 2 do local img = Image(24, 24, ColorMode.RGB)
    for y = 0, 23 do for x = 0, 23 do if (x - 11.5) ^ 2 + (y - 11.5) ^ 2 < 100 then img:drawPixel(x, y, Color(200, 120, 60)) end end end
    s.layers[1]:cel(f).image = img end return true`);
await lua(`AsepriteAgent.chat(${JSON.stringify(`/skill:normal-map Make a normal map for the Orb for Godot, check it under a light, and export the sheets to ${dir} as orb.`)}, "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 600_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const s = await lua(`local s = app.sprite local nl
  for _, l in ipairs(s.layers) do if l.name:match("normal") then nl = l end end
  if not nl or not nl:cel(1) then return { ok = false } end
  local c = nl:cel(1) local function g(x, y) local p = c.image:getPixel(x - c.position.x, y - c.position.y) return { app.pixelColor.rgbaR(p), app.pixelColor.rgbaG(p) } end
  return { ok = true, name = nl.name, visible = nl.isVisible, frames = nl:cel(2) ~= nil, top = g(11, 3), right = g(20, 11) }`);
check("a normal layer for both frames", s.ok && s.frames, s);
check("normals point outward (green up at the top, red at the right)", s.ok && s.top[1] > 160 && s.right[0] > 160, s);
check("the normal layer is hidden", s.ok && s.visible === false, s);
check("sheets exported", existsSync(join(dir, "orb.png")) && existsSync(join(dir, "orb_n.png")));
const e = await lua("return AsepriteAgent.entries()");
check("it previewed the lighting", e.some((x) => x.kind === "tool" && /Preview lighting/.test(x.text ?? "")), e.filter((x) => x.kind === "tool").map((x) => x.text));
console.log(failed ? `NORMALS TEST FAILED (${failed})` : "NORMALS TEST PASSED");
process.exit(failed ? 1 : 0);
