// Attachments (#21): image files become ACP image blocks; old renders are cleaned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanAttachments, loadAttachments } from "../dist/attachments.js";

const dir = mkdtempSync(join(tmpdir(), "att-"));

test("attachments load as base64 image blocks", () => {
  const png = join(dir, "a.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual(loadAttachments([{ label: "selection", path: png }]), [
    { label: "selection", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
  ]);
  assert.deepEqual(loadAttachments(undefined), []);
  assert.throws(() => loadAttachments([{ label: "notes", path: join(dir, "a.txt") }]), /only PNG/);
  assert.throws(() => loadAttachments([{ label: "gone", path: join(dir, "gone.png") }]), /file not found/);
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
