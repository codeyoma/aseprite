// The declarative apply tool (#88) over the fake document: the ops are checked
// in the bridge (every structural problem by its op path, nothing sent), then
// run in one request; a dry run changes nothing; look/check come back with it.
// What the ops do is a contract scenario (agent/tests/contract/apply.json),
// replayed against the fake and a headless Aseprite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTool, runTool, toolContext } from "../dist/tools.js";
import { checkOps, OP_NAMES } from "../dist/apply.js";
import { documentOf } from "../dist/document.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const red = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) d.set([255, 0, 0, 255], i * 4); return d; };
const sprite = () => fakeDocument({ width: 4, height: 2, layers: [{ name: "Body", frames: [red(4, 2)] }], tags: [{ name: "idle", from: 1, to: 1 }] });

test("apply runs every op in one request and reports the changes and new layers", async () => {
  const doc = sprite();
  const res = await runTool(findTool("apply"), { ops: [
    { op: "add_layer", name: "Ink", above: "Body" },
    { op: "line", layer: "Ink", points: [[0, 0], [3, 1]], color: "#00ff00" },
    { op: "add_frames", count: 2, empty: true },
    { op: "set_duration", frames: "2-3", ms: 60 },
    { op: "set_tag", name: "idle", to: 3, direction: "ping-pong" },
  ] }, toolContext(doc));
  assert.equal(res.isError, undefined, textOf(res));
  assert.equal(doc.calls.filter((c) => c.method === "apply").length, 1, "one request");
  assert.match(textOf(res), /^Applied in one undo step:/);
  assert.match(textOf(res), /Ink frame 1: 4 of 4 pixels changed/);
  assert.match(textOf(res), /New layers: Ink \(L\d+\)/);
  assert.match(textOf(res), /Frames: 3/);
  const info = await documentOf(doc).info();
  assert.deepEqual(info.durations, [100, 60, 60]);
  assert.deepEqual(info.tags.map((t) => [t.name, t.from, t.to]), [["idle", 1, 3]]);
  assert.deepEqual(info.layers.map((l) => l.name), ["Ink", "Body"]);
});

test("structural mistakes come back by op path before anything is sent", async () => {
  const doc = sprite();
  const res = await runTool(findTool("apply"), { ops: [
    { op: "rect", x: 0, y: 0, w: 0, h: 1, color: "#ff0000" },
    { op: "paint" },
    { op: "set_layer", layer: "Body", colour: "red" },
    { op: "set_palette", colors: ["red"] },
  ] }, toolContext(doc));
  assert.equal(res.isError, true);
  const t = textOf(res);
  assert.match(t, /^Nothing changed\. Fix these ops:/);
  assert.match(t, /ops\[0\]\.w \(rect\)/);
  assert.match(t, /ops\[1\]\.op: unknown op "paint"/);
  assert.match(t, /ops\[2\]\.colour \(set_layer\): unknown param colour/);
  assert.match(t, /ops\[3\]\.colors\[0\] \(set_palette\)/);
  assert.equal(doc.calls.some((c) => c.method === "apply"), false, "nothing sent");
  assert.deepEqual(checkOps([{ op: "pixels", rows: [". 1"], legend: { 1: "#ff0000" } }]), []);
  assert.equal(OP_NAMES.length, 16);
});

test("ops that fail in the document roll everything back and list each problem", async () => {
  const doc = sprite();
  const res = await runTool(findTool("apply"), { ops: [
    { op: "add_layer", name: "Ink" },
    { op: "rect", layer: "Nope", x: 0, y: 0, w: 1, h: 1, color: "#ff0000" },
    { op: "delete_tag", name: "walk" },
  ] }, toolContext(doc));
  assert.equal(res.isError, true);
  assert.match(textOf(res), /ops\[1\] \(rect\): Layer not found: Nope/);
  assert.match(textOf(res), /ops\[2\] \(delete_tag\): No tag named walk/);
  assert.match(textOf(res), /Ops that ran before the rollback:\n- Added layer Ink/);
  assert.deepEqual((await documentOf(doc).info()).layers.map((l) => l.name), ["Body"]);
});

test("dry_run lists the changes and changes nothing; look and check come back with an applied change", async () => {
  const doc = sprite();
  const dry = await runTool(findTool("apply"), { dry_run: true, look: true, ops: [{ op: "delete_layer", layer: "Body" }, { op: "add_frames" }] }, toolContext(doc));
  assert.match(textOf(dry), /^Dry run, nothing changed\. The ops would:\n- Deleted layer Body\n- Added 1 frame after frame 1/);
  assert.equal(dry.content.some((c) => c.type === "image"), false, "no look on a dry run");
  assert.deepEqual((await documentOf(doc).info()).layers.map((l) => l.name), ["Body"]);

  const checks = [];
  const looked = await runTool(findTool("apply"), { look: true, check: true, ops: [{ op: "rect", x: 0, y: 0, w: 1, h: 1, color: "." }] },
    toolContext({
      request: (m, p) => {
        if (m === "check") { checks.push(p); return { result: { errors: 0, warnings: 0, findings: [], checked: { layers: 1, frames: 1 } } }; }
        return doc.request(m, p);
      },
    }));
  assert.equal(looked.isError, undefined, textOf(looked));
  assert.ok(looked.content.some((c) => c.type === "image"), "the snapshot");
  assert.match(textOf(looked), /Check: 0 errors/);
  assert.equal(checks.length, 1);
});

test("Document.apply sends the ops and returns the result", async () => {
  const doc = sprite();
  const r = await documentOf(doc).apply([{ op: "append_palette", colors: ["#123456"] }], { dryRun: true });
  assert.deepEqual([r.ok, r.applied, r.dryRun, r.changes], [true, false, true, ["Palette: added 1 colors"]]);
});
