// Live test of Voxels to isometric sprites (#45).
// Run with Aseprite open:  node agent/tests/voxels_live.mjs <dir> [claude|codex]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPalette, writeVox } from "../bridge/dist/voxels.js";
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
async function chat(prompt) {
  await lua(`AsepriteAgent.chat(${JSON.stringify(prompt)}, "${provider}", "agent") return true`);
  const t0 = Date.now();
  while (Date.now() - t0 < 500_000) {
    await sleep(2500);
    if (!(await lua("return AsepriteAgent.isBusy()"))) return;
  }
}
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const vox = [];
for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 4; z++) if (x === 0 || y === 0 || x === 5 || y === 5 || z === 0) vox.push([x, y, z, 1]);
for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) vox.push([x, y, 4, 2]);
const pal = defaultPalette();
pal[1] = { r: 194, g: 195, b: 199, a: 255 };
pal[2] = { r: 255, g: 0, b: 77, a: 255 };
const path = join(dir, "house.vox");
writeFileSync(path, writeVox({ sx: 6, sy: 6, sz: 5, voxels: vox, palette: pal }));

await chat(`/skill:voxel-sprites Render the voxel house at ${path} in 4 isometric directions.`);
const a = await lua(`local s = app.sprite local o = {} for _, t in ipairs(s.tags) do o[#o + 1] = t.name end return { frames = #s.frames, tags = o, w = s.width, h = s.height }`);
check(".vox: 4 direction frames tagged", a.frames === 4 && ["SE", "SW", "NW", "NE"].every((t) => a.tags.includes(t)), a);

await lua(`local s = Sprite(8, 8, ColorMode.RGB) s.layers[1].name = "z0"
  for z = 1, 3 do local l = z == 1 and s.layers[1] or s:newLayer() l.name = "z" .. (z - 1)
    local img = Image(8, 8, ColorMode.RGB) for y = z, 7 - z do for x = z, 7 - z do img:drawPixel(x, y, Color(60, 170, 80)) end end
    s:newCel(l, 1, img, Point(0, 0)) end return true`);
await chat("/skill:voxel-sprites Stack these layers (bottom = ground) into an isometric object, 4 directions.");
const b = await lua(`local s = app.sprite return { frames = #s.frames, layers = #s.layers, title = app.fs.fileTitle(s.filename) }`);
check("layers: a new 4-frame isometric sprite", b.frames === 4 && b.layers === 1, b);
console.log(failed ? `VOXELS TEST FAILED (${failed})` : "VOXELS TEST PASSED");
process.exit(failed ? 1 : 0);
