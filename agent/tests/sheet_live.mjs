// Live test of sprite sheet import (#41): the skill on a 2x4 sheet with a
// key-color background, and an atlas round trip through Aseprite's own
// --sheet export. Run with Aseprite open:  node agent/tests/sheet_live.mjs <scratch dir> [claude|codex]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";
import { startBridge, textOf, waitForAseprite } from "./mcp_client.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const aseBin = fileURLToPath(new URL("../../build/bin/aseprite", import.meta.url));
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
const tagsOf = () => lua(`local o = {} for _, t in ipairs(app.sprite.tags) do o[#o + 1] = t.name .. " " .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber end return { frames = #app.sprite.frames, w = app.sprite.width, h = app.sprite.height, tags = o }`);

// 1. A 4x2 sheet of 24x24 cells on magenta: a bobbing body (row 1) and a stepping one (row 2).
const W = 96, H = 48, png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H * 4; i += 4) png.data.set([255, 0, 255, 255], i);
const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) png.data.set([...c, 255], (j * W + i) * 4); };
for (let f = 0; f < 4; f++) {
  rect(f * 24 + 7, 6 + (f % 2), 10, 16 - (f % 2), [60, 170, 80]);
  rect(f * 24 + 6 + f, 30, 10, 18, [41, 120, 255]);
  rect(f * 24 + 4 + 2 * f, 44, 4, 4, [41, 120, 255]);
}
const sheet = join(dir, "hero_sheet.png");
writeFileSync(sheet, PNG.sync.write(png));
await lua(`Sprite(16, 16) AsepriteAgent.attach{ path = ${JSON.stringify(sheet)} } return true`);
await lua(`AsepriteAgent.chat("/skill:import-sheet It's a 4x2 grid of 24x24 cells. Row 1 is idle, row 2 is walk.", "${provider}", "agent") return true`);
const t0 = Date.now();
while (Date.now() - t0 < 400_000) {
  await sleep(2500);
  if (!(await lua("return AsepriteAgent.isBusy()"))) break;
}
const s = await tagsOf();
check("skill: 8 frames of 24x24 with idle and walk tags", s.frames === 8 && s.w === 24 && s.h === 24 &&
  s.tags.includes("idle 1-4") && s.tags.includes("walk 5-8"), s);

// 2. Atlas round trip: a sprite exported by Aseprite with --trim imports back exactly.
const src = join(dir, "roundtrip.aseprite");
await lua(`local s = Sprite(12, 10, ColorMode.RGB) s:newFrame() s:newFrame()
  for f = 1, 3 do local img = Image(12, 10, ColorMode.RGB)
    for y = 2, 6 do for x = f, f + 4 do img:drawPixel(x, y, Color(40 * f, 100, 200)) end end
    s.layers[1]:cel(f).image = img s.frames[f].duration = 0.05 * f end
  local t = s:newTag(1, 3) t.name = "pulse" s:saveAs(${JSON.stringify(src)}) return true`);
const r = spawnSync(aseBin, ["-b", src, "--trim", "--sheet", join(dir, "rt.png"), "--data", join(dir, "rt.json"), "--format", "json-hash", "--list-tags"], { encoding: "utf8" });
check("Aseprite exported the sheet", r.status === 0, r.stderr);
const imp = await c.call("import_sheet", { path: join(dir, "rt.png") });
const rt = await tagsOf();
check("atlas: frames, size and tag come back", rt.frames === 3 && rt.w === 12 && rt.h === 10 && rt.tags.includes("pulse 1-3"), { rt, text: textOf(imp) });
const same = await lua(`local s = app.sprite local ok = true
  for f = 1, 3 do local img = Image(12, 10, ColorMode.RGB) img:drawSprite(s, f)
    for y = 0, 9 do for x = 0, 11 do
      local inside = y >= 2 and y <= 6 and x >= f and x <= f + 4
      local a = app.pixelColor.rgbaA(img:getPixel(x, y))
      if (inside and (a == 0 or app.pixelColor.rgbaR(img:getPixel(x, y)) ~= 40 * f)) or (not inside and a ~= 0) then ok = false end
    end end
    if math.abs(s.frames[f].duration - 0.05 * f) > 0.001 then ok = false end
  end return ok`);
check("atlas: pixels and durations match the original", same === true);

console.log(failed ? `SHEET TEST FAILED (${failed})` : "SHEET TEST PASSED");
process.exit(failed ? 1 : 0);
