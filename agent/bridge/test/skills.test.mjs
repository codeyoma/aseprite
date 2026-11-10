// User skills (#27): folder, frontmatter, override, triggers and /skill:name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "skills-"));
process.env.ASEPRITE_AGENT_SKILLS = dir;
const { allSkills, guideIndex, parseSkill, readGuide, skillContext, INLINE_SKILL_CHARS } = await import("../dist/guide.js");
const { findTool, runTool } = await import("../dist/tools.js");

writeFileSync(join(dir, "dithering.md"), `---
name: dithering
description: Ordered dithering for 16-color sprites
triggers: [dither, gradient]
---
Use a 2x2 Bayer pattern. Never dither single pixels.
`);
writeFileSync(join(dir, "outline.md"), `---
description: "My outline style"
triggers:
  - outline
  - "rim"
---
${"Outline with the darkest palette color. ".repeat(80)}
`);
writeFileSync(join(dir, "basics.md"), "# My basics\nOverride.\n");

test("frontmatter: inline and block lists, quotes, heading fallback", () => {
  const s = parseSkill("---\nname: X\ntriggers:\n  - a\n  - 'b c'\n---\nbody", "x", "user");
  assert.deepEqual([s.name, s.triggers, s.body], ["x", ["a", "b c"], "body"]);
  assert.equal(parseSkill("# Title here\ntext", "t", "user").description, "Title here");
});

test("user skills are listed and readable; a same-name skill overrides the built-in", async () => {
  const skills = allSkills();
  assert.ok(skills.has("recipes") && skills.get("recipes").source === "built-in");
  assert.equal(skills.get("basics").source, "user");
  assert.equal(readGuide("dithering").trim(), "Use a 2x2 Bayer pattern. Never dither single pixels.");
  assert.match(guideIndex(), /- dithering \(your skill\): Ordered dithering/);
  const listed = await runTool(findTool("read_guide"), {}, { request: async () => ({}) });
  assert.match(listed.content[0].text, /outline \(your skill\): My outline style/);
});

test("trigger words inline short skills and hint long ones", () => {
  const r = skillContext("Shade the sky with a gradient");
  assert.deepEqual(r.used, ["dithering"]);
  assert.match(r.context, /<skill name="dithering" note="matched 'gradient'/);
  assert.equal(r.message, "Shade the sky with a gradient");
  const long = skillContext("add an outline");
  assert.ok(readGuide("outline").length > INLINE_SKILL_CHARS);
  assert.match(long.context, /^Relevant skill: outline \(My outline style\)\. Call read_guide\("outline"\)/);
  assert.deepEqual(skillContext("draw a cat").used, []);
  assert.deepEqual(skillContext("redithering").used, [], "triggers match at word starts");
});

test("/skill:name forces a skill", () => {
  const r = skillContext("/skill:dithering make the sky nicer");
  assert.equal(r.message, "make the sky nicer");
  assert.match(r.context, /the user asked you to follow this skill/);
  assert.match(skillContext("/skill:nope hi").context, /there is none/);
});
