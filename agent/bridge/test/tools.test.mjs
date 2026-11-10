// The Tool table, tested through runTool with a fake Aseprite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { describeTool, toolKind } from "../dist/tool_labels.js";
import { findTool, runTool, TOOLS } from "../dist/tools.js";

/** Records requests and answers them from `replies` (method -> reply or function). */
function fakeAseprite(replies = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params = {}) {
      calls.push({ method, params });
      const r = replies[method];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(params) : (r ?? { result: { ok: true } });
    },
  };
}
const textOf = (res) => res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("every tool is fully defined", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "unique names");
  for (const t of TOOLS) {
    assert.ok(t.title && t.description, `${t.name}: title and description`);
    assert.ok(t.kind === "edit" || t.kind === "read", `${t.name}: kind`);
    assert.ok(t.label({}).length > 0, `${t.name}: label`);
    const required = new Set(["execute_lua", "run_command", "propose_variations", "save_command", "run_saved_command", "delete_saved_command", "apply_timeline_text", "spawn_agents", "import_sheet", "recreate_from_reference", "make_ramp", "transform_layer", "rotate_layer", "squash_stretch", "smear_frame", "mirror_direction", "dither_gradient", "palette_swap", "export_palette_lut", "export_normal_sheet", "export_for_engine", "draw_text", "make_ui", "render_voxels"]);
    assert.ok(t.input.safeParse({}).success || required.has(t.name), `${t.name}: optional input`);
  }
});

test("labels and kinds come from the table", () => {
  assert.equal(describeTool("execute_lua", { label: "Add Shadow layer" }), "Add Shadow layer");
  assert.equal(describeTool("run_command", { name: "CanvasSize" }), "Run CanvasSize");
  assert.equal(describeTool("unknown_tool", {}), "unknown_tool");
  assert.equal(toolKind("execute_lua"), "edit");
  assert.equal(toolKind("snapshot"), "read");
});

test("tools without run forward to Aseprite", async () => {
  const aseprite = fakeAseprite({ get_state: { result: { activeSprite: { width: 8 } } } });
  const res = await runTool(findTool("get_state"), {}, aseprite);
  assert.deepEqual(aseprite.calls, [{ method: "get_state", params: {} }]);
  assert.equal(JSON.parse(textOf(res)).activeSprite.width, 8);

  await runTool(findTool("undo"), { steps: 2 }, aseprite);
  assert.deepEqual(aseprite.calls.at(-1), { method: "undo", params: { steps: 2 } });
});

test("errors become MCP error results", async () => {
  const res = await runTool(findTool("get_context"), {}, fakeAseprite({ get_context: new Error("Aseprite is not connected") }));
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not connected/);
});

test("execute_lua reports output, value and rollback", async () => {
  const ok = await runTool(findTool("execute_lua"), { code: "return 1" },
    fakeAseprite({ execute_lua: { result: { ok: true, value: 1, output: ["hi"] } } }));
  assert.match(textOf(ok), /Output:\nhi/);
  assert.match(textOf(ok), /"value": 1/);

  const bad = await runTool(findTool("execute_lua"), { code: "error()" },
    fakeAseprite({ execute_lua: { result: { ok: false, error: "boom", rolledBack: true, output: [] } } }));
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /rolled back/);
});

test("run_command: suggestions, color params, not executed", async () => {
  const unknown = await runTool(findTool("run_command"), { name: "SpriteSiz" }, fakeAseprite());
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /Did you mean: .*SpriteSize/);

  const aseprite = fakeAseprite({ run_command: { result: { executed: true } } });
  const res = await runTool(findTool("run_command"), { name: "replacecolor", params: { from: "#ff0000", tolerance: 0 } }, aseprite);
  assert.equal(textOf(res), "ReplaceColor ran.");
  assert.deepEqual(aseprite.calls[0].params, { name: "ReplaceColor", params: { from: { __color: "#ff0000" }, tolerance: 0 } });

  const notRun = await runTool(findTool("run_command"), { name: "Undo" },
    fakeAseprite({ run_command: { result: { executed: false, note: "not enabled" } } }));
  assert.equal(notRun.isError, true);
});

test("read_pixels formats a grid with a legend", async () => {
  const res = await runTool(findTool("read_pixels"), { x: 0, y: 9, width: 3, height: 2 }, fakeAseprite({
    read_pixels: { result: { x: 0, y: 9, width: 3, height: 2, frame: 1, keys: "color-key",
      legend: { "1": "#00ff00", "0": "#ff0000" }, rows: [". 0 1", "0 0 ."] } },
  }));
  const lines = textOf(res).split("\n");
  assert.match(lines[0], /^Region x=0 y=9 3x2, frame 1/);
  assert.equal(lines[1], "Legend: 0=#ff0000  1=#00ff00");
  assert.deepEqual(lines.slice(2), [" 9| . 0 1", "10| 0 0 ."]);
});

test("snapshot encodes an upscaled PNG", async () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]); // 2x1: red, half-transparent blue
  const res = await runTool(findTool("snapshot"), { scale: 4, background: "transparent" }, fakeAseprite({
    snapshot: { result: { width: 2, height: 1, frame: 1, binary: true }, binary: rgba },
  }));
  const img = res.content.find((c) => c.type === "image");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  assert.equal(png.width, 8);
  assert.equal(png.height, 4);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.match(textOf(res), /2x1 px, frame 1, shown at 4x/);

  const missing = await runTool(findTool("snapshot"), {}, fakeAseprite({ snapshot: { result: { width: 1, height: 1 } } }));
  assert.equal(missing.isError, true);
});

test("read_guide and list_commands work offline", async () => {
  const topics = await runTool(findTool("read_guide"), {}, fakeAseprite());
  assert.match(textOf(topics), /basics/);
  assert.equal((await runTool(findTool("read_guide"), { topic: "nope" }, fakeAseprite())).isError, true);
  assert.match(textOf(await runTool(findTool("list_commands"), { filter: "canvas" }, fakeAseprite())), /CanvasSize/);
});

import { formatCheck } from "../dist/tools.js";

test("check: formats findings with coordinates and fixes", async () => {
  const result = {
    errors: 1, warnings: 1, checked: { layers: 2, frames: 3, rules: [] },
    findings: [
      { rule: "off-palette", severity: "error", layer: "Body", layerId: "L3", frame: 2, color: "#fa0a0a", count: 25,
        pixels: [[4, 7], [5, 7]], fix: "Use palette index 2 (#ff0000), the nearest color" },
      { rule: "frame-duration", severity: "warning", tag: "idle", frames: [3], fix: "Set frame 3 to 100 ms" },
    ],
  };
  const out = formatCheck(result).split("\n");
  assert.equal(out[0], "Check: 1 errors, 1 warnings (2 layers, 3 frames)");
  assert.match(out[1], /^- error off-palette \[L3 Body, frame 2\]: #fa0a0a 25 px at \(4,7\) \(5,7\) …$/);
  assert.match(out[2], /fix: Use palette index 2/);
  assert.match(out[3], /^- warning frame-duration \[tag idle, frames 3\]/);
  assert.equal(formatCheck({ errors: 0, warnings: 0, findings: [], checked: { layers: 1, frames: 1 } }),
    "Check: 0 errors, 0 warnings (1 layers, 1 frames). No problems found.");

  const res = await runTool(findTool("check"), { rules: ["orphan"] }, fakeAseprite({ check: { result } }));
  assert.match(textOf(res), /^Check: 1 errors/);
  assert.equal(toolKind("check"), "read");
});

test("diff_visual: returns the diff PNG, bounds and count", async () => {
  const w = 4, h = 2;
  const binary = Buffer.alloc(w * h * 4);
  binary.writeUInt32BE(0xff0000ff, 0); // one red pixel at 0,0
  const fake = fakeAseprite({
    diff_visual: { result: { width: w, height: h, changed: 1, against: "before the last edit step (execute_lua)", bounds: { x: 0, y: 0, width: 1, height: 1 } }, binary },
  });
  const res = await runTool(findTool("diff_visual"), {}, fake);
  const img = res.content.find((c) => c.type === "image");
  assert.ok(img, "has an image");
  const png = PNG.sync.read(Buffer.from(img.data, "base64"));
  assert.equal(png.width, w * 128);
  assert.match(textOf(res), /1 pixels changed, bounds x=0 y=0 w=1 h=1, compared with before the last edit step/);
  assert.equal(toolKind("diff_visual"), "read");

  const none = await runTool(findTool("diff_visual"), { checkpoint: "start" },
    fakeAseprite({ diff_visual: { result: { width: w, height: h, changed: 0, against: "checkpoint start" }, binary } }));
  assert.equal(textOf(none), "No pixels changed (compared with checkpoint start).");
  assert.ok(!none.content.some((c) => c.type === "image"));

  const saved = fakeAseprite();
  assert.equal(textOf(await runTool(findTool("diff_visual"), { save: "start" }, saved)), 'Saved checkpoint "start".');
  assert.deepEqual(saved.calls[0], { method: "diff_visual", params: { save: "start", checkpoint: undefined } });
});

test("propose_variations: names the candidates and how the user picks", async () => {
  const fake = fakeAseprite({ propose_variations: { result: { task: "sword", count: 2, layers: ["AI: sword v1", "AI: sword v2"], shown: true } } });
  const res = await runTool(findTool("propose_variations"), { task: "sword" }, fake);
  assert.equal(textOf(res), 'Showing 2 variations of "sword": AI: sword v1, AI: sword v2. The user sees them in the chat panel and will keep one or discard them.');
  assert.deepEqual(fake.calls[0], { method: "propose_variations", params: { task: "sword" } });
  assert.equal(toolKind("propose_variations"), "read");
});

test("timeline text: plan, apply, errors with line numbers", async () => {
  const get = await runTool(findTool("get_timeline_text"), {}, fakeAseprite({ get_timeline_text: { result: { text: "frames 4\n" } } }));
  assert.equal(textOf(get), "frames 4\n");
  const planned = await runTool(findTool("apply_timeline_text"), { text: "fps 10", plan: true },
    fakeAseprite({ apply_timeline_text: (p) => ({ result: { ok: true, errors: [], changes: ["Frames 1-4 duration 100ms -> 100ms"], plan: p.plan } }) }));
  assert.match(textOf(planned), /^Planned changes \(not applied\):\n- Frames 1-4/);
  const bad = await runTool(findTool("apply_timeline_text"), { text: "tg x" },
    fakeAseprite({ apply_timeline_text: { result: { ok: false, errors: ["line 1: unknown line 'tg'"], changes: [] } } }));
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /line 1: unknown line 'tg'/);
  const none = await runTool(findTool("apply_timeline_text"), { text: "frames 4" },
    fakeAseprite({ apply_timeline_text: { result: { ok: true, errors: [], changes: [] } } }));
  assert.equal(textOf(none), "No changes: the timeline already matches.");
});
