// import_animation: an animated file becomes frames as it is, with its own
// timing, either as a new sprite or on a new layer of the open sprite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool, runTool } from "../dist/tools.js";
import { importDecoder } from "../dist/sheet_tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const dir = mkdtempSync(join(tmpdir(), "anim-"));
const gif = join(dir, "walk.gif");
writeFileSync(gif, "GIF89a");
const frame = (x) => ({ width: 4, height: 4, data: rect(4, 4, [x, 1, x + 1, 2], [200, 30, 30]) });
importDecoder.decode = async () => ({ frames: [frame(0), frame(1), frame(2)], durations: [100, 100, 300] });

test("import_animation opens a new sprite with the file's frames, timing and colors", async () => {
  const fake = fakeDocument({ width: 8, height: 8 });
  const r = await runTool(findTool("import_animation"), { path: gif }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Opened "walk": 3 frames of 4x4 \(durations 100, 100, 300 ms\)/);
  const call = fake.calls.find((c) => c.method === "create_animation");
  assert.deepEqual(call.params.frames.map((f) => f.duration), [100, 100, 300]);
  assert.deepEqual(call.params.palette, ["#c81e1e"]);
});

test("import_animation onto a layer: from frame 2, frames added, durations set, centered", async () => {
  const fake = fakeDocument({ width: 8, height: 8, frames: 2, layers: [{ name: "Body", frames: [null, null] }] });
  const r = await runTool(findTool("import_animation"), { path: gif, into: "layer", frame: 2 }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Put 3 frames of 4x4 at 2,2 on layer "AI: walk", frames 2-4, 2 frames added/);
  const info = (await fake.request("get_state", {})).result;
  assert.deepEqual(info.activeSprite.frames.map((f) => f.durationMs), [100, 100, 100, 300]);
  const ims = fake.images("AI: walk");
  assert.equal(ims.filter(Boolean).length, 3);
  const at = (img, x, y) => [...img.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
  assert.deepEqual(at(ims[1], 2, 3), [200, 30, 30], "frame 2 holds the file's frame 1, moved to 2,2");

  const again = await runTool(findTool("import_animation"), { path: gif, into: "layer" }, fake);
  assert.match(textOf(again), /already has a layer 'AI: walk'/);
});

test("import_animation refuses what it can't read", async () => {
  const fake = fakeDocument({ width: 8, height: 8 });
  assert.match(textOf(await runTool(findTool("import_animation"), { path: join(dir, "notes.txt") }, fake)), /Not an image file/);
  assert.match(textOf(await runTool(findTool("import_animation"), { path: join(dir, "gone.gif") }, fake)), /File not found/);
});
