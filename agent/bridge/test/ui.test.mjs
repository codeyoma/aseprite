// Pixel text and UI elements (#50).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont, measureText, panel, renderText } from "../dist/ui.js";
import { findTool, runTool } from "../dist/tools.js";

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
  const calls = [];
  const pico = ["#000000", "#1d2b53", "#29adff", "#fff1e8", "#83769c", "#c2c3c7"];
  const fake = { async request(m, p) {
    calls.push({ m, p });
    if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 48, height: 16, frames: [100].map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "L" }], tags: [], palette: { colors: pico } } } };
    return { result: { title: p.title } };
  } };
  const r = await runTool(findTool("make_ui"), { kind: "button", width: 48, height: 16, fill: "#29adff", label: "Play" }, fake);
  const anim = calls.find((c) => c.m === "create_animation").p;
  assert.equal(anim.frames.length, 4);
  assert.deepEqual(anim.tags.map((t) => t.name), ["normal", "hover", "pressed", "disabled"]);
  const slice = calls.find((c) => c.m === "set_slice").p;
  assert.deepEqual(slice.center, { x: 2, y: 2, w: 44, h: 12 });
  assert.notEqual(anim.frames[0].rgba, anim.frames[2].rgba, "pressed differs");
  // Every state, hover and disabled included, stays in the palette.
  for (const f of anim.frames) {
    const d = Buffer.from(f.rgba, "base64");
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) assert.ok(pico.includes("#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")));
  }
  assert.match(r.content[0].text, /48x16 button with normal, hover, pressed and disabled frames/);
});
