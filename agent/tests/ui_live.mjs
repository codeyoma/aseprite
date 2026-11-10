// Live test of Pixel text and UI (#50): a 3-state button and a panel in
// the sprite's palette, with 9-patch slices.
// Run with Aseprite open:  node agent/tests/ui_live.mjs [claude|codex]
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { live } from "./live.mjs";
import { textOf } from "./mcp_client.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, ranSkill, done } = await live({ provider });
const PICO = ["000000", "1d2b53", "7e2553", "008751", "ab5236", "5f574f", "c2c3c7", "fff1e8", "ff004d", "ffa300", "ffec27", "00e436", "29adff", "83769c", "ff77a8", "ffccaa"];
await lua(`local s = Sprite(64, 64, ColorMode.RGB) local p = Palette(16)
  local hx = { ${PICO.map((h) => `"${h}"`).join(", ")} }
  for i, h in ipairs(hx) do p:setColor(i - 1, Color(tonumber(h:sub(1, 2), 16), tonumber(h:sub(3, 4), 16), tonumber(h:sub(5, 6), 16))) end
  s:setPalette(p) return true`);
await chat("/skill:make-ui Make a 'Play' button with normal, hover and pressed states and a small panel, using this sprite's palette.");
await ranSkill("make-ui");
const all = await lua(`local out = {}
  for _, s in ipairs(app.sprites) do
    local tags = {} for _, t in ipairs(s.tags) do tags[#tags + 1] = t.name end
    local nine = false for _, sl in ipairs(s.slices) do if sl.center then nine = true end end
    local seen, cols = {}, {}
    for f = 1, #s.frames do local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, f)
      for it in img:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 then local k = string.format("%02x%02x%02x", app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v)) if not seen[k] then seen[k] = true cols[#cols + 1] = k end end end end
    out[#out + 1] = { title = app.fs.fileTitle(s.filename), w = s.width, frames = #s.frames, tags = tags, nine = nine, colors = cols }
  end return out`);
const tagged = (s) => s.tags.some((t) => /hover/i.test(t)) && s.tags.some((t) => /press/i.test(t));
const button = all.find((s) => s.frames >= 3 && tagged(s)) ?? all.find((s) => s.frames >= 3);
const panelS = all.find((s) => s !== button && s.nine && s.frames === 1);
check("a button with 3 or more state frames", !!button, all.map((s) => [s.title, s.frames, s.tags]));
soft("its states are tagged hover and pressed", button && tagged(button), button?.tags);
check("a panel", !!panelS, all.map((s) => [s.title, s.frames, s.nine]));
check("both have 9-patch slices", button?.nine && panelS?.nine, { button: button?.nine, panel: panelS?.nine });
const offPalette = [...(button?.colors ?? []), ...(panelS?.colors ?? [])].filter((h) => !PICO.includes(h));
soft("in the sprite's palette", offPalette.length === 0, offPalette);

// User fonts (#61): a TrueType file and an installed font, pixel-exact.
await lua(`Sprite(96, 32, ColorMode.RGB) return true`);
const ttf = "/System/Library/Fonts/Supplemental/Arial.ttf";
const t1 = await c.call("draw_text", { text: "Score 99", font: ttf, size: 12, x: 2, y: 2, color: "#ffffff" });
const ink = await lua(`local s = app.sprite local n, other = 0, 0
  for _, l in ipairs(s.layers) do if l.name == "AI: text" then local cel = l:cel(1)
    for it in cel.image:pixels() do local v = it() if app.pixelColor.rgbaA(v) > 0 then
      if app.pixelColor.rgbaA(v) == 255 and app.pixelColor.rgbaR(v) == 255 then n = n + 1 else other = other + 1 end end end end end
  return { n = n, other = other }`);
check("TTF text: crisp white pixels only", !t1.isError && ink.n > 20 && ink.other === 0, { ink, text: textOf(t1) });

// 9-patch export: the button's slice reaches the JSON, Unity's border and a Godot NinePatchRect.
const dir = mkdtempSync(join(tmpdir(), "ui9-"));
await c.call("make_ui", { kind: "panel", width: 32, height: 24, fill: "#1d2b53", border: "#fff1e8", name: "Box" });
await c.call("export_for_engine", { engine: "godot", dir, name: "box" });
await c.call("export_for_engine", { engine: "unity", dir: join(dir, "u"), name: "box" });
const meta = JSON.parse(readFileSync(join(dir, "box.json"), "utf8")).meta;
check("JSON has the 9-patch slice", meta.slices?.[0]?.keys?.[0]?.center?.w > 0, meta.slices);
const scene = existsSync(join(dir, "box_ninepatch.tscn")) ? readFileSync(join(dir, "box_ninepatch.tscn"), "utf8") : "";
check("Godot NinePatchRect with margins", /NinePatchRect/.test(scene) && /patch_margin_left = [1-9]/.test(scene), scene.slice(0, 200));
const unity = readFileSync(join(dir, "u", "box.png.meta"), "utf8");
check("Unity sprite border set", /border: \{x: [1-9]/.test(unity), unity.match(/border: .*/)?.[0]);

// The agent writes with an installed font.
await lua(`Sprite(96, 32, ColorMode.RGB) return true`);
await chat("/skill:make-ui Write 'GAME OVER' in the installed font Arial at 12 px, white, at 4,4. Nothing else.");
await ranSkill("make-ui");
const sys = await lua(`local n = 0 for _, l in ipairs(app.sprite.layers) do local cel = l:cel(1) if cel then
  for it in cel.image:pixels() do if app.pixelColor.rgbaA(it()) > 0 then n = n + 1 end end end end return n`);
check("the agent drew system-font text", sys > 30, sys);
done("UI");
