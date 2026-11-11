// Pixel text and UI elements (#50).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, measureText, panel, renderText } from "../dist/ui.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

const colors = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(img.data.slice(i, i + 4).join()); return s; };

test("Aseprite's fonts load; text is pixel-exact in the given colors", () => {
  const f = loadFont("aseprite"), m = loadFont("mini");
  assert.equal(f.height, 7);
  assert.equal(m.height, 5);
  const t = renderText("Hi", f, { color: [255, 0, 77] });
  assert.deepEqual([...colors(t)], ["255,0,77,255"], "one color, no anti-aliasing");
  assert.deepEqual([t.width, t.height], [measureText("Hi", f).width, 7]);
  const o = renderText("Hi", f, { color: [255, 241, 232], outline: [24, 20, 37], shadow: [29, 43, 83] });
  assert.equal(colors(o).size, 3);
  assert.equal(renderText("A\nB", f, { color: [1, 2, 3] }).height, 14);
  assert.equal(renderText("Hi", f, { color: [1, 2, 3], scale: 2 }).width, t.width * 2);
  // Same text, same pixels (the font is deterministic).
  assert.deepEqual(Buffer.from(renderText("Score 100", f, { color: [9, 9, 9] }).data), Buffer.from(renderText("Score 100", f, { color: [9, 9, 9] }).data));
});

test("panels: border, rounded corners, 9-patch center", () => {
  const p = panel(20, 12, { fill: [41, 120, 255], border: [24, 20, 37], highlight: [140, 200, 255], shadow: [29, 43, 83], radius: 1 });
  const at = (x, y) => [...p.image.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
  assert.equal(at(0, 0)[3], 0, "corner cut");
  assert.deepEqual(at(5, 0), [24, 20, 37, 255], "border");
  assert.deepEqual(at(5, 1), [140, 200, 255, 255], "highlight");
  assert.deepEqual(at(5, 10), [29, 43, 83, 255], "shadow");
  assert.deepEqual(at(10, 5), [41, 120, 255, 255], "fill");
  assert.deepEqual(p.center, { x: 2, y: 2, w: 16, h: 8 });
});

test("make_ui button: 4 tagged frames and a 9-patch slice", async () => {
  const pico = ["#000000", "#1d2b53", "#29adff", "#fff1e8", "#83769c", "#c2c3c7"];
  const fake = fakeDocument({ width: 48, height: 16, palette: pico, layers: [{ name: "L", frames: [new Uint8Array(48 * 16 * 4)] }] });
  const r = await runTool(findTool("make_ui"), { kind: "button", width: 48, height: 16, fill: "#29adff", label: "Play" }, fake);
  const sent = (m) => fake.calls.find((c) => c.method === m).params;
  const anim = sent("create_animation");
  assert.equal(anim.frames.length, 4);
  assert.deepEqual(anim.tags.map((t) => t.name), ["normal", "hover", "pressed", "disabled"]);
  const slice = sent("set_slice");
  assert.deepEqual(slice.center, { x: 2, y: 2, w: 44, h: 12 });
  assert.notEqual(anim.frames[0].rgba, anim.frames[2].rgba, "pressed differs");
  // Every state, hover and disabled included, stays in the palette.
  for (const f of anim.frames) {
    const d = Buffer.from(f.rgba, "base64");
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) assert.ok(pico.includes("#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")));
  }
  assert.match(r.content[0].text, /48x16 button with normal, hover, pressed and disabled frames/);
});

test("make_ui button in a fixed palette: every state differs, disabled has no bevel, the sprite gets the palette", async () => {
  const pico = ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"];
  const fake = fakeDocument({ width: 32, height: 16, palette: pico, layers: [{ name: "L", frames: [new Uint8Array(32 * 16 * 4)] }] });
  const r = await runTool(findTool("make_ui"), { kind: "button", width: 32, height: 15, fill: "#008751", label: "Play" }, fake);
  assert.ok(!r.isError);
  const anim = fake.calls.find((c) => c.method === "create_animation").params;
  assert.deepEqual(anim.palette, pico, "the new sprite carries the palette it was snapped to");
  const px = (f, x, y) => { const d = Buffer.from(anim.frames[f].rgba, "base64"); const i = (y * 32 + x) * 4; return [d[i], d[i + 1], d[i + 2]].join(); };
  const fill = (f) => px(f, 16, 2); // inside the bevel, above the label
  assert.equal(new Set(anim.frames.map((f) => f.rgba)).size, 4, "four distinct states");
  // Hover: PICO-8's lighter green would wash out the cream label, so the fill stays and the frame lights up.
  assert.notEqual(px(1, 16, 0), px(0, 16, 0), "hover's frame differs from normal's");
  assert.equal(fill(1), fill(0));
  const blue = await runTool(findTool("make_ui"), { kind: "button", width: 32, height: 15, fill: "#1d2b53", label: "Go", name: "b2" }, fake);
  assert.ok(!blue.isError);
  const b2 = fake.calls.filter((c) => c.method === "create_animation").at(-1).params;
  const at = (f, x, y) => { const d = Buffer.from(b2.frames[f].rgba, "base64"); const i = (y * 32 + x) * 4; return [d[i], d[i + 1], d[i + 2]].join(); };
  assert.notEqual(at(1, 16, 3), at(0, 16, 3), "a dark fill has room for a lighter hover fill");
  // Disabled: the bevel rows (just inside the border) are the fill.
  assert.equal(px(3, 16, 1), px(3, 16, 4), "disabled has no highlight row");
  assert.equal(px(3, 16, 13), px(3, 16, 4), "disabled has no shadow row");
  const { paletteStep } = await import("../dist/ui_tools.js");
  const hexOf = (c) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  const rgba = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: 255 });
  assert.equal(hexOf(paletteStep(rgba("#008751"), pico.map(rgba), 1)), "#00e436", "green steps to the lighter green");
});

test("BMFont text and XML: glyphs placed by offsets, advance and kerning", async () => {
  const { parseBMFont, bmfontInk, styleInk } = await import("../dist/ui.js");
  // A page with two 2x3 glyphs: "A" at (0,0) and "B" at (2,0), fully opaque.
  const page = { width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(255) };
  const txt = `info face="t" size=4
common lineHeight=5 base=4 scaleW=4 scaleH=3 pages=1
page id=0 file="t_0.png"
chars count=2
char id=65 x=0 y=0 width=2 height=3 xoffset=0 yoffset=1 xadvance=3 page=0
char id=66 x=2 y=0 width=2 height=3 xoffset=0 yoffset=1 xadvance=3 page=0
kerning first=65 second=66 amount=-1
`;
  const loaded = [];
  const font = parseBMFont(txt, (f) => { loaded.push(f); return page; });
  assert.deepEqual(loaded, ["t_0.png"]);
  const ink = bmfontInk("AB", font);
  assert.deepEqual([ink.width, ink.height], [5, 5]);
  const row = (y) => [...ink.ink.slice(y * ink.width, (y + 1) * ink.width)].join("");
  assert.equal(row(0), "00000");
  assert.equal(row(1), "11110", "B is kerned 1 px left, touching A");
  const xml = `<font><common lineHeight="5"/><pages><page id="0" file="t_0.png"/></pages><chars><char id="65" x="0" y="0" width="2" height="3" xoffset="0" yoffset="1" xadvance="3" page="0"/></chars></font>`;
  assert.equal(parseBMFont(xml, () => page).chars.get(65).xa, 3);
  const img = styleInk(ink, { color: [255, 0, 0], outline: [0, 0, 0] });
  assert.deepEqual([img.width, img.height], [7, 7]);
  assert.throws(() => parseBMFont("info x=1", () => page), /Not a BMFont/);
});
