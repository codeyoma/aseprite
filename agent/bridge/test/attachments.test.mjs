// Attachments (#21): image files become ACP image blocks; old renders are cleaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanAttachments, loadAttachments, renderFrames, sniffImage } from "../dist/attachments.js";
import { shrink } from "../dist/image.js";

const dir = mkdtempSync(join(tmpdir(), "att-"));

const fakePng = (w, h, extra = []) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  return Buffer.concat([sig, chunk("IHDR", ihdr), ...extra.map((t) => chunk(t, Buffer.alloc(8))), chunk("IDAT", Buffer.alloc(2))]);
};
const solid = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });
const noDecoder = async () => { throw new Error("decoder should not run"); };

test("a PNG of a sensible size goes as it is, with its size in the label", async () => {
  const png = join(dir, "a.png");
  const bytes = fakePng(300, 200);
  writeFileSync(png, bytes);
  assert.deepEqual(await loadAttachments([{ label: "selection", path: png }], noDecoder), [
    { label: "selection (300x200)", mimeType: "image/png", data: bytes.toString("base64") },
  ]);
  assert.deepEqual(await loadAttachments(undefined), []);
  await assert.rejects(loadAttachments([{ label: "notes", path: join(dir, "a.txt") }]), /attach an image/);
  await assert.rejects(loadAttachments([{ label: "gone", path: join(dir, "gone.png") }]), /file not found/);
});

test("headers: PNG, APNG, JPEG, GIF and WebP sizes and animation", () => {
  assert.deepEqual(sniffImage(fakePng(4, 3)), { format: "png", width: 4, height: 3, animated: false });
  assert.equal(sniffImage(fakePng(4, 3, ["acTL"])).animated, true);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0]);
  assert.deepEqual(sniffImage(jpeg), { format: "jpeg", width: 40, height: 30, animated: false });
  // GIF: header, no global table, two image descriptors with one-byte data.
  const desc = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 1, 0x44, 0];
  const gif = (n) => Buffer.from([...Buffer.from("GIF89a", "latin1"), 2, 0, 2, 0, 0, 0, 0, ...Array(n).fill(desc).flat(), 0x3b]);
  assert.deepEqual(sniffImage(gif(1)), { format: "gif", width: 2, height: 2, animated: false });
  assert.equal(sniffImage(gif(2)).animated, true);
  const vp8x = Buffer.alloc(30); vp8x.write("RIFF", 0, "latin1"); vp8x.write("WEBP", 8, "latin1"); vp8x.write("VP8X", 12, "latin1");
  vp8x[20] = 0x02; vp8x.writeUIntLE(63, 24, 3); vp8x.writeUIntLE(31, 27, 3);
  assert.deepEqual(sniffImage(vp8x), { format: "webp", width: 64, height: 32, animated: true });
  assert.equal(sniffImage(Buffer.from("BM0000000000000000000000000")).format, undefined);
});

test("other formats, animations and tiny images are converted with the decoder", async () => {
  const bmp = join(dir, "s.bmp"), small = join(dir, "s.png"), anim = join(dir, "walk.gif");
  writeFileSync(bmp, "BM"); writeFileSync(small, fakePng(16, 16)); writeFileSync(anim, "GIF89a");
  const calls = [];
  const decode = async (path) => {
    calls.push(path);
    if (path === anim) return { frames: [solid(8, 8), solid(8, 8), solid(8, 8)], durations: [100, 100, 300] };
    return { frames: [solid(16, 16)], durations: [100] };
  };
  const [a, b, c] = await loadAttachments([{ label: "image s.bmp", path: bmp }, { label: "sprite", path: small }, { label: "walk", path: anim }], decode);
  assert.deepEqual(calls, [bmp, small, anim]);
  assert.equal(a.mimeType, "image/png");
  assert.equal(a.label, "image s.bmp (16x16 px, shown at 32x)");
  assert.equal(b.label, "sprite (16x16 px, shown at 32x)");
  assert.match(c.label, /^walk \(animation, 3 frames of 8x8 px \(durations 100, 100, 300 ms\), shown as a sheet/);
  await assert.rejects(loadAttachments([{ label: "bad", path: bmp }], async () => { throw new Error("cannot open\nmore"); }), /bad: Aseprite could not read it \(cannot open\)/);
});

test("large images are scaled down; one frame stays one image", () => {
  const r = renderFrames("photo", { frames: [solid(4000, 3000)], durations: [100] });
  assert.equal(r.label, "photo (4000x3000, shown scaled down to 1280x960)");
  const s = shrink({ width: 2, height: 2, data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]) }, 1);
  assert.deepEqual([...s.data], [128, 128, 128, 128]);
});

test("old attachments are cleaned", () => {
  const old = join(dir, "old.png");
  const fresh = join(dir, "fresh.png");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  assert.ok(cleanAttachments(dir) >= 1);
  assert.ok(!existsSync(old) && existsSync(fresh));
});
