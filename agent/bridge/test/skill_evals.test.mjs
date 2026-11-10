// Skill evals (#58): every built-in skill in agent/skills has an eval module
// in agent/tests/skills/<name>.eval.mjs. Each one builds an in-memory sprite,
// runs the skill's deterministic tools in order and checks what the skill
// promises. Skills whose tools all need the live extension say why they skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSkill } from "../dist/guide.js";
import { findTool, runTool } from "../dist/tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(here, "..", "..", "skills");
const EVALS = join(here, "..", "..", "tests", "skills");
const LUA_TESTS = join(here, "..", "..", "tests");

const skills = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory() && existsSync(join(SKILLS, n, "SKILL.md"))).sort();
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("there are built-in skills to evaluate", () => {
  assert.ok(skills.length >= 20, `found ${skills.length} skills in ${SKILLS}`);
});

test("every eval module belongs to a built-in skill", () => {
  const stray = readdirSync(EVALS).filter((f) => f.endsWith(".eval.mjs")).map((f) => f.replace(/\.eval\.mjs$/, "")).filter((n) => !skills.includes(n));
  assert.deepEqual(stray, [], "eval modules without a skill");
});

for (const name of skills) {
  test(`skill eval: ${name}`, async (t) => {
    const file = join(EVALS, `${name}.eval.mjs`);
    assert.ok(existsSync(file), `missing eval for skill '${name}': add agent/tests/skills/${name}.eval.mjs`);
    const ev = (await import(pathToFileURL(file).href)).default;
    assert.equal(ev?.skill, name, `${name}.eval.mjs exports skill '${ev?.skill}'`);
    if (ev.skip) {
      // A plain reason, or { reason, luaTest } naming the headless Lua test
      // (agent/tests/<luaTest>, run by tests/run_lua_tests.sh) that covers it.
      const reason = typeof ev.skip === "string" ? ev.skip : ev.skip.reason;
      assert.equal(typeof reason, "string", "skip is a reason or { reason, luaTest }");
      if (typeof ev.skip === "object") {
        assert.equal(typeof ev.skip.luaTest, "string", "skip object names its luaTest");
        assert.ok(existsSync(join(LUA_TESTS, ev.skip.luaTest)), `skip.luaTest '${ev.skip.luaTest}' not found in agent/tests`);
      }
      t.skip(typeof ev.skip === "object" ? `${reason} (covered by ${ev.skip.luaTest})` : reason);
      return;
    }
    const skill = parseSkill(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"), name, "built-in");
    assert.ok(Array.isArray(ev.steps) && ev.steps.length, "an eval runs at least one step");
    for (const s of ev.steps) {
      assert.ok(skill.tools.includes(s.tool), `step tool '${s.tool}' is not in ${name}'s SKILL.md tools [${skill.tools.join(", ")}]`);
      assert.ok(findTool(s.tool), `no tool named '${s.tool}'`);
    }
    const fake = await ev.fixture();
    const results = [];
    for (const [i, s] of ev.steps.entries()) {
      const r = await runTool(findTool(s.tool), s.input, fake);
      assert.ok(!r.isError, `step ${i + 1} (${s.tool}) failed: ${textOf(r)}`);
      results.push(r);
    }
    await ev.check(fake, results, assert);
  });
}
