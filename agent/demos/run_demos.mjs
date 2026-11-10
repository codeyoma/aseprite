// Runs the README demo scenarios against a live Aseprite through the MCP
// bridge, calling the same tools an agent would, and saves the results to
// agent/demos/output/. Run with Aseprite open:  node agent/demos/run_demos.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { imageOf, startBridge, textOf, waitForAseprite } from "../tests/mcp_client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "output");
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(here, "../bridge/package.json"));
const { PNG } = require("pngjs");

const client = await startBridge();
await waitForAseprite(client);

let failed = 0;
async function step(label, name, args, check = () => true) {
  const r = await client.call(name, args);
  const t = textOf(r);
  const ok = !r.isError && check(t, r);
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : ": " + t.slice(0, 300)}`);
  return r;
}
const lua = (label, code, check, opts = {}) => step(label, "execute_lua", { code, label, ...opts }, check);
const value = (t) => JSON.parse(t.slice(t.indexOf("{"))).value;
async function snap(file, args = {}) {
  const r = await step(`snapshot ${file}`, "snapshot", args, (_, res) => !!imageOf(res));
  const png = imageOf(r);
  if (png) writeFileSync(join(OUT, file), png);
}
// Close only the sprite this demo created (the active one), never other open work.
const closeDemoSprite = () => lua("close demo sprite", "if app.sprite then app.sprite:close() end", undefined, { transaction: false });

// A smooth, anti-aliased "photo" to pixelate: sky gradient, sun, two hills.
function makeSourceImage(path) {
  const W = 256, H = 192;
  const png = new PNG({ width: W, height: H });
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = y / H;
      let r = mix(70, 250, t), g = mix(110, 170, t), b = mix(200, 140, t);
      const ds = Math.hypot(x - 180, y - 70);
      const sun = Math.max(0, Math.min(1, (30 - ds) / 2));
      r = mix(r, 255, sun); g = mix(g, 230, sun); b = mix(b, 120, sun);
      const hill1 = 130 + 25 * Math.sin(x / 40);
      const h1 = Math.max(0, Math.min(1, (y - hill1) / 1.5));
      r = mix(r, 60 + y / 8, h1); g = mix(g, 140 - y / 6, h1); b = mix(b, 70, h1);
      const hill2 = 160 + 15 * Math.sin(x / 25 + 2);
      const h2 = Math.max(0, Math.min(1, (y - hill2) / 1.5));
      r = mix(r, 35, h2); g = mix(g, 90, h2); b = mix(b, 55, h2);
      const i = (y * W + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

// 1. Turn an image into pixel art
const src = join(OUT, "source.png");
makeSourceImage(src);
await lua("pixelate 64x48, 12 colors", `
  local s = app.open(${JSON.stringify(src)})
  app.command.SpriteSize{ ui = false, width = 64, height = 48, lockRatio = false, method = "bilinear" }
  app.command.ColorQuantization{ ui = false, maxColors = 12, withAlpha = true }
  app.command.ChangePixelFormat{ ui = false, format = "indexed" }
  return { w = s.width, h = s.height, colors = #s.palettes[1] }
`, (t) => value(t).w === 64, { transaction: false });
await snap("1-pixelate.png", { scale: 8 });

await closeDemoSprite();

// 2. Layers: Body plus a half-transparent Shadow underneath
await lua("sprite with Body layer", `
  local s = Sprite(32, 32)
  s.layers[1].name = "Body"
  local img = Image(32, 32)
  for y = 0, 31 do for x = 0, 31 do
    local dx, dy = x - 15.5, y - 13.5
    local d = dx * dx + dy * dy
    if d <= 100 then
      local light = (dx + dy) < -6 and Color(120, 200, 255) or ((dx + dy) > 6 and Color(30, 90, 170) or Color(60, 140, 220))
      img:drawPixel(x, y, light)
    elseif d <= 121 then img:drawPixel(x, y, Color(20, 30, 60)) end
  end end
  s:newCel(s.layers[1], 1, img, Point(0, 0))
  return "ok"
`, undefined, { transaction: false });
await lua("add Shadow under Body at 50%", `
  local s = app.sprite
  local body = s.layers[1]
  local sh = s:newLayer(); sh.name = "Shadow"; sh.stackIndex = body.stackIndex; sh.opacity = 128
  local img = Image(32, 32)
  for y = 26, 29 do for x = 6, 25 do
    local dx, dy = (x - 15.5) / 10, (y - 27.5) / 2
    if dx * dx + dy * dy <= 1 then img:drawPixel(x, y, Color(0, 0, 0)) end
  end end
  s:newCel(sh, 1, img, Point(0, 0))
  return { order = { s.layers[1].name, s.layers[2].name } }
`, (t) => value(t).order[0] === "Shadow");
await snap("2-layers.png", { scale: 8 });

// 3. Canvas size
await step("canvas 32x32 -> 48x40", "run_command", { name: "CanvasSize", params: { left: 8, right: 8, top: 8 } });
await step("state shows 48x40", "get_state", {}, (t) => JSON.parse(t).activeSprite.width === 48 && JSON.parse(t).activeSprite.height === 40);
await snap("3-canvas.png", { scale: 6 });
await step("undo canvas size", "undo", {});

// 4. Idle bob animation with a tag, exported as GIF
await lua("idle bob, 6 frames, tag idle", `
  local s = app.sprite
  local body, shadow = s.layers[2], s.layers[1]
  local OFFSETS = { 0, -1, -2, -2, -1, 0 }
  local base, shBase = body:cel(1), shadow:cel(1)
  while #s.frames < #OFFSETS do s:newEmptyFrame(#s.frames + 1) end
  for i, dy in ipairs(OFFSETS) do
    s.frames[i].duration = 0.12
    if i > 1 then
      s:newCel(body, i, base.image, Point(base.position.x, base.position.y + dy))
      s:newCel(shadow, i, shBase.image, shBase.position)
    end
  end
  local tag = s:newTag(1, #OFFSETS); tag.name = "idle"
  return { frames = #s.frames }
`, (t) => value(t).frames === 6);
await step("export GIF x8", "run_command", { name: "SaveFileCopyAs", params: { filename: join(OUT, "4-idle.gif"), scale: 8 } });

// 5. Retime 6 -> 12 frames at the same speed
await lua("retime 6 -> 12 frames", `
  local s = app.sprite
  for i = #s.frames, 1, -1 do
    local d = s.frames[i].duration
    s:newFrame(i)
    s.frames[i].duration = d / 2
    s.frames[i + 1].duration = d / 2
  end
  local total = 0
  for _, f in ipairs(s.frames) do total = total + f.duration end
  return { frames = #s.frames, seconds = math.floor(total * 100 + 0.5) / 100 }
`, (t) => value(t).frames === 12 && value(t).seconds === 0.72);

// 6. Sprite sheet + JSON
const sheet = join(OUT, "6-sheet");
await step("export sprite sheet", "run_command", {
  name: "ExportSpriteSheet",
  params: { type: "horizontal", textureFilename: sheet + ".png", dataFilename: sheet + ".json", dataFormat: "json-array", listTags: true },
});

// 7. UI commands: show the timeline, onion skin, play
await step("show grid", "run_command", { name: "ShowGrid" });
await step("onion skin", "run_command", { name: "ShowOnionSkin" });

await step("save demo .aseprite", "execute_lua", { code: `app.sprite:saveAs(${JSON.stringify(join(OUT, "demo.aseprite"))})`, transaction: false });
await closeDemoSprite();

console.log(failed ? `${failed} FAILED` : "ALL DEMOS PASSED");
client.stop();
process.exit(failed ? 1 : 0);
