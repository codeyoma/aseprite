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

test("info is fresh after a palette write, a split and a slice in the same run", async () => {
  const fake = fakeDocument({ width: 4, height: 2, palette: ["#000000"], layers: [{ name: "Art", frames: [rect(4, 2, [0, 0, 1, 1], [255, 0, 0])] }] });
  const doc = documentOf(fake);
  assert.equal((await doc.info()).palette.length, 1);
  await doc.setPalette([{ r: 255, g: 0, b: 0, a: 255 }, { r: 0, g: 0, b: 255, a: 255 }]);
  assert.deepEqual((await doc.info()).palette.map((c) => [c.r, c.g, c.b]), [[255, 0, 0], [0, 0, 255]]);
  await doc.setPalette([{ r: 0, g: 0, b: 255, a: 255 }, { r: 0, g: 255, b: 0, a: 255 }], { append: true });
  assert.equal((await doc.palette()).length, 3, "append skips colors the palette has");
  await doc.splitByColors([{ name: "Red", colors: ["#ff0000"] }], { layer: "Art" });
  assert.deepEqual((await doc.info()).layers.map((l) => l.name), ["Red"], "the emptied source layer is gone");
  await doc.setSlice({ name: "all" });
  assert.deepEqual((await doc.info()).slices, [{ name: "all", bounds: { x: 0, y: 0, w: 4, h: 2 }, center: undefined }], "w/h default to the sprite size");
});

test("document colors, color maps, mirror and swatches against the fake", async () => {
  const W = 4, d = rect(W, 2, [0, 0, 0, 1], [255, 0, 0]);
  d.set([0, 0, 255, 255], 1 * 4);
  const fake = fakeDocument({ width: W, height: 2, frames: 2, tags: [{ name: "walk_E", from: 1, to: 1 }], layers: [{ name: "Art", frames: [d] }], selection: { x: 0, y: 0, width: 1, height: 1 } });
  const doc = documentOf(fake);
  const all = await doc.colors();
  assert.deepEqual(all.colors.map((c) => [c.r, c.b, c.count]), [[255, 0, 2], [0, 255, 1]]);
  assert.equal((await doc.colors({ selection: true })).pixels, 1);
  assert.deepEqual(await doc.applyColorMap({ "#0000ff": "#00ff00" }), { changed: 1, mode: "pixels" });
  assert.deepEqual(await doc.mirrorFrames({ tag: "walk_E", newTag: "walk_W" }), { from: 3, to: 3, frames: 1 });
  const info = await doc.info();
  assert.equal(info.durations.length, 3);
  assert.deepEqual(info.tags.at(-1), { name: "walk_W", from: 3, to: 3, direction: "forward", repeat: 0 });
  assert.deepEqual([...fake.cel("Art", 3).subarray((W - 1) * 4, W * 4)], [255, 0, 0, 255], "flipped");
  await doc.drawSwatches([{ r: 1, g: 2, b: 3, a: 255 }]);
  assert.ok((await doc.info()).layers.some((l) => l.name === "AI: palette"));
});

test("the fake refuses what the extension refuses: splitting groups or non-RGB sprites", async () => {
  const groups = [{ name: "A", colors: ["#ff0000"] }];
  const grp = documentOf(fakeDocument({ width: 2, height: 2, layers: [{ name: "Art", frames: [rect(2, 2, [0, 0, 1, 1], [255, 0, 0])] }, { name: "G", group: true }] }));
  await assert.rejects(grp.splitByColors(groups, { layer: "G" }), /Pick an image layer/);
  const idx = fakeDocument({ width: 2, height: 2, colorMode: "indexed", palette: ["#ff0000"], layers: [{ name: "Art", frames: [rect(2, 2, [0, 0, 1, 1], [255, 0, 0])] }] });
  await assert.rejects(documentOf(idx).splitByColors(groups), /needs an RGB sprite/);
  assert.deepEqual(await documentOf(idx).applyColorMap({ "#ff0000": "#00ff00" }), { changed: 1, mode: "palette entries" });
  assert.deepEqual(idx.active.sprite.palette, ["#00ff00"]);
});
