// Saved commands (#26): storage with git versions, and the tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cmds-"));
process.env.ASEPRITE_AGENT_COMMANDS = dir;
const { SavedCommands } = await import("../dist/saved_commands.js");
const { findTool, runTool, toolContext, withDefaults } = await import("../dist/tools.js");
// The tools get the store through their ToolContext.
const ctx = (fake) => toolContext(fake, { commands: new SavedCommands(dir) });

function fakeAseprite(replies = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params = {}) {
      calls.push({ method, params });
      const r = replies[method];
      return typeof r === "function" ? r(params) : (r ?? { result: { ok: true } });
    },
  };
}
const textOf = (res) => res.content.map((c) => c.text).join("\n");

test("save, versions, revert, disable, delete", () => {
  const store = new SavedCommands(join(dir, "store"));
  store.save({ name: "outline-dark", title: "Outline Dark", description: "Outline in the darkest color", code: "return 1" });
  store.save({ name: "outline-dark", title: "Outline Dark", description: "Thicker outline", code: "return 2", params: [{ name: "width", default: 1 }] });
  assert.equal(store.code("outline-dark"), "return 2\n");
  const versions = store.history("outline-dark");
  assert.deepEqual(versions.map((v) => v.message), ["Update outline-dark: Thicker outline", "Add outline-dark: Outline in the darkest color"]);
  store.revert("outline-dark");
  assert.equal(store.code("outline-dark"), "return 1\n");
  assert.equal(store.history("outline-dark")[0].message, `Revert outline-dark to ${versions[1].rev}`);
  assert.ok(store.setEnabled("outline-dark", false) && store.get("outline-dark").enabled === false);
  assert.throws(() => store.save({ name: "Bad Name", title: "x", description: "x", code: "" }), /lowercase/);
  assert.ok(store.delete("outline-dark") && store.list().length === 0);
});

test("save_command compiles first and reports errors back", async () => {
  const bad = fakeAseprite({ compile_lua: { result: { ok: false, error: "command:1: unexpected symbol near 'end'" } } });
  const r = await runTool(findTool("save_command"), { name: "bob", title: "Bob", description: "Bob up and down", code: "end" }, ctx(bad));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /does not compile.*unexpected symbol/s);
  assert.ok(!new SavedCommands().get("bob"));

  const good = fakeAseprite();
  const ok = await runTool(findTool("save_command"), { name: "bob", title: "Bob", description: "Bob up and down", code: "return args.height", params: [{ name: "height", default: 2 }] }, ctx(good));
  assert.match(textOf(ok), /Saved "Bob" as \/bob/);
  assert.deepEqual(good.calls.map((c) => c.method), ["compile_lua", "commands_changed"]);
  assert.equal(good.calls[1].params.dir, dir);
  assert.match(readFileSync(join(dir, "commands.json"), "utf8"), /"name": "bob"/);
});

test("run_saved_command sends the code with arguments over defaults", async () => {
  const fake = fakeAseprite({ execute_lua: { result: { ok: true, value: 5 } } });
  const r = await runTool(findTool("run_saved_command"), { name: "bob", args: { height: 5 } }, ctx(fake));
  assert.match(textOf(r), /"value": 5/);
  assert.deepEqual(fake.calls[0].params, { code: "return args.height\n", label: "Bob", args: { height: 5 } });
  assert.deepEqual(withDefaults({ params: [{ name: "height", default: 2 }] }), { height: 2 });
  assert.equal((await runTool(findTool("run_saved_command"), { name: "nope" }, ctx(fake))).isError, true);
  assert.match(textOf(await runTool(findTool("list_saved_commands"), {}, ctx(fake))), /- \/bob: Bob\. Bob up and down Params: height=2/);
  assert.match(textOf(await runTool(findTool("delete_saved_command"), { name: "bob" }, ctx(fake))), /Deleted \/bob/);
});

test("the panel's commands.* methods use the given store", async () => {
  const { commandMethods } = await import("../dist/saved_commands.js");
  const store = new SavedCommands(join(dir, "panel"));
  store.save({ name: "wave", title: "Wave", description: "First", code: "return 1" });
  store.save({ name: "wave", title: "Wave", description: "Second", code: "return 2" });
  const m = commandMethods(store);
  assert.equal(m["commands.history"]({ name: "wave" }).versions.length, 2);
  assert.ok(m["commands.revert"]({ name: "wave" }).restored);
  assert.equal(store.code("wave"), "return 1\n");
  assert.deepEqual(m["commands.setEnabled"]({ name: "wave", enabled: false }), { ok: true });
  assert.equal(store.get("wave").enabled, false);
});
