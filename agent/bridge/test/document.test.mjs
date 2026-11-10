// The document module (#52) and skill tools run against an in-memory sprite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { documentOf, parseState, resolveFrames } from "../dist/document.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const opaque = (d) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };

test("frame specs", () => {
  assert.deepEqual(resolveFrames(undefined, 4, 2), [2]);
  assert.deepEqual(resolveFrames("all", 3, 1), [1, 2, 3]);
  assert.deepEqual(resolveFrames("2-4", 5, 1), [2, 3, 4]);
  assert.deepEqual(resolveFrames([1, 3], 3, 1), [1, 3]);
  assert.throws(() => resolveFrames(5, 3, 1), /out of range/);
  assert.throws(() => resolveFrames("abc", 3, 1), /Frames must be/);
});

test("get_state becomes SpriteInfo: flat layers with paths and ids, active layer by id", () => {
  const info = parseState({
    activeFrame: 2, activeLayerId: "L3",
    activeSprite: {
      filename: "/x/hero.aseprite", width: 8, height: 6,
      frames: [{ durationMs: 100 }, { durationMs: 150 }],
      layers: [{ id: "L1", name: "Body", group: true, visible: true, layers: [{ id: "L3", name: "Arm", group: false, visible: false }] }],
      tags: [{ name: "walk", from: 1, to: 2, direction: "pingpong", repeat: 2 }],
      palette: { colors: ["#00000000", "#ff0000"] },
      selection: { x: 1, y: 2, width: 3, height: 4 },
    },
  });
  assert.equal(info.title, "hero");
  assert.deepEqual(info.durations, [100, 150]);
  assert.deepEqual([info.layer, info.layerId, info.frame], ["Arm", "L3", 2]);
  assert.deepEqual(info.layers.map((l) => [l.name, l.path.join("/"), l.visible]), [["Body", "", true], ["Arm", "Body", false]]);
  assert.equal(info.palette.length, 1, "transparent entries skipped");
  assert.deepEqual(info.selection, { x: 1, y: 2, w: 3, h: 4 });
  assert.throws(() => parseState({}), /No active sprite/);
});

test("document round trip: info is cached until a write; pixels and put", async () => {
  const fake = fakeDocument({ width: 4, height: 4, frames: 2, layers: [{ name: "A", frames: [rect(4, 4, [0, 0, 1, 1], [255, 0, 0])] }] });
  const doc = documentOf(fake);
  await doc.info();
  await doc.info();
  assert.equal(fake.calls.filter((c) => c.method === "get_state").length, 1);
  const px = await doc.pixels("A", 1);
  assert.equal(opaque(px.data), 4);
  await doc.putImage(px, { newLayer: "copy", frame: 2 });
  assert.deepEqual(fake.layerNames(), ["A", "AI: copy"]);
  await doc.info();
  assert.equal(fake.calls.filter((c) => c.method === "get_state").length, 2, "a write invalidates the info");
  await assert.rejects(doc.putImage({ width: 2, height: 2, data: new Uint8Array(3) }), /3 bytes for 2x2/);
});

test("shade_sprite and outline_sprite through the document", async () => {
  const fake = fakeDocument({ width: 12, height: 12, layers: [{ name: "Blob", frames: [rect(12, 12, [2, 2, 9, 9], [60, 170, 80])] }], palette: ["#3caa50"] });
  let r = await runTool(findTool("shade_sprite"), { layer: "Blob", light: "top-left" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.ok(fake.layerNames().includes("AI: shaded Blob"), fake.layerNames().join());
  r = await runTool(findTool("outline_sprite"), { layer: "Blob" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.ok(opaque(fake.cel("AI: outline")) > 0);
});

test("dither_to_palette and make_normal_map through the document", async () => {
  const grad = new Uint8Array(8 * 4 * 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) grad.set([x * 32, x * 32, x * 32, 255], (y * 8 + x) * 4);
  const fake = fakeDocument({ width: 8, height: 4, layers: [{ name: "Sky", frames: [grad] }] });
  let r = await runTool(findTool("dither_to_palette"), { layer: "Sky", colors: ["#000000", "#ffffff"] }, fake);
  assert.ok(!r.isError, textOf(r));
  const d = fake.cel("AI: dithered Sky");
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) colors.add(d[i]);
  assert.deepEqual([...colors].sort((a, b) => a - b), [0, 255]);
  r = await runTool(findTool("normal_map"), { layer: "Sky" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.ok(fake.layerNames().includes("AI: normal Sky"));
});

test("draw_text and layers_to_voxels through the document", async () => {
  const fake = fakeDocument({ width: 32, height: 12, layers: [{ name: "BG", frames: [new Uint8Array(32 * 12 * 4)] }] });
  let r = await runTool(findTool("draw_text"), { text: "HI", x: 1, y: 1, color: "#ffffff" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.ok(opaque(fake.cel("AI: text")) > 0);
  const vox = fakeDocument({ width: 4, height: 4, layers: [
    { name: "z0", frames: [rect(4, 4, [0, 0, 3, 3], [120, 90, 60])] },
    { name: "z1", frames: [rect(4, 4, [1, 1, 2, 2], [120, 90, 60])] },
  ] });
  r = await runTool(findTool("layers_to_voxels"), {}, vox);
  assert.ok(!r.isError, textOf(r));
  assert.equal(vox.sprites.length, 2, "a new sprite with the render");
});
