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
${"Outline with the darkest palette color. ".repeat(300)}
`);
writeFileSync(join(dir, "basics.md"), "# My basics\nOverride.\n");

test("frontmatter: inline and block lists, quotes, heading fallback", () => {
  const s = parseSkill("---\nname: X\ntriggers:\n  - a\n  - 'b c'\n---\nbody", "x", "user");
  assert.deepEqual([s.name, s.triggers, s.body], ["x", ["a", "b c"], "body"]);
  assert.equal(parseSkill("# Title here\ntext", "t", "user").description, "Title here");
});

test("user skills are listed and readable; a same-name skill overrides the built-in", async () => {
  const skills = allSkills();
  assert.ok(skills.has("recipes") && skills.get("recipes").source === "guide");
  assert.equal(skills.get("basics").source, "user");
  assert.equal(readGuide("dithering").trim(), "Use a 2x2 Bayer pattern. Never dither single pixels.");
  assert.match(guideIndex(), /- dithering \(your skill\): Ordered dithering/);
  const listed = await runTool(findTool("read_guide"), {}, { request: async () => ({}) });
  assert.match(listed.content[0].text, /outline \(your skill\): My outline style/);
});

test("trigger words inline short skills and hint long ones", () => {
  const r = skillContext("Shade the sky with a gradient");
  // The built-in Shade and outline skill also matches "shade": one primary workflow, the other only named (#100).
  assert.deepEqual(r.used, ["dithering"]);
  assert.match(r.context, /<skill name="dithering" note="matched 'gradient'/);
  assert.match(r.context, /Other skills that may help[^\n]*shade-sprite/);
  assert.ok(!r.context.includes('<skill name="shade-sprite"'));
  assert.equal(r.message, "Shade the sky with a gradient");
  const long = skillContext("add an outline");
  assert.ok(readGuide("outline").length > INLINE_SKILL_CHARS);
  assert.match(long.context, /Relevant skill: outline \(My outline style\)\. Call read_guide\("outline"\)/);
  assert.deepEqual(skillContext("draw a cat").used, []);
  assert.deepEqual(skillContext("redithering").used, [], "triggers match at word starts");
});

test("/skill:name forces a skill", () => {
  const r = skillContext("/skill:dithering make the sky nicer");
  assert.equal(r.message, "make the sky nicer");
  assert.match(r.context, /the user asked you to follow this skill/);
  assert.match(skillContext("/skill:nope hi").context, /there is none/);
});

test("the catalog lists built-in skills with titles and categories, and searches them", async () => {
  const { catalog, searchCatalog } = await import("../dist/guide.js");
  const rows = catalog();
  const check = rows.find((r) => r.name === "check-sprite");
  assert.deepEqual([check.title, check.category, check.source], ["Check and fix pixel art", "Cleanup", "built-in"]);
  assert.ok(rows.some((r) => r.name === "dithering" && r.source === "user"));
  assert.equal(searchCatalog("retime")[0].name, "retime-animation");
  assert.equal(searchCatalog("variations")[0].name, "make-variations");
  assert.deepEqual(searchCatalog("zzz-nothing"), []);
  const { findTool, runTool } = await import("../dist/tools.js");
  const listed = await runTool(findTool("list_skills"), { query: "frames" }, { request: async () => ({}) });
  assert.match(listed.content[0].text, /parallel-frames: Work on many frames at once \[Animation, built-in\]/);
});

test("a user skill overrides a built-in skill of the same name", async () => {
  writeFileSync(join(dir, "check-sprite.md"), "---\ntitle: My check\n---\nMine.\n");
  const { allSkills } = await import("../dist/guide.js");
  const s = allSkills().get("check-sprite");
  assert.deepEqual([s.title, s.source, s.body.trim()], ["My check", "user", "Mine."]);
});

test("frontmatter: needs and tools", () => {
  const s = parseSkill("---\nneeds: [image]\ntools: [palette_from_image]\ncategory: Color\n---\nx", "p", "built-in");
  assert.deepEqual([s.needs, s.tools, s.category, s.title], [["image"], ["palette_from_image"], "Color", "p"]);
});

test("every built-in skill lists only real tools", async () => {
  const { allSkills } = await import("../dist/guide.js");
  const { TOOLS } = await import("../dist/tools.js");
  const names = new Set(TOOLS.map((t) => t.name));
  for (const s of allSkills().values()) {
    if (s.source !== "built-in") continue;
    for (const t of s.tools) assert.ok(names.has(t), `${s.name} lists unknown tool ${t}`);
  }
});

test("skills are routed by intent: one primary workflow, the rest named (#100)", () => {
  const primary = (msg) => skillContext(msg).used[0];
  assert.equal(primary("Export an atlas for Godot"), "export-game");
  assert.equal(primary("Import this sprite sheet atlas and slice it"), "import-sheet");
  assert.equal(primary("Make 8 directions from this sprite"), "make-directions");
  assert.equal(primary("Turn this glb model into 8 directions"), "model-to-sprites");
  const atlas = skillContext("Export an atlas for Godot");
  assert.ok(!atlas.context.includes("# Import a sprite sheet"), "the import skill's text is not loaded");
  assert.match(atlas.context, /Other skills[^\n]*import-sheet/);
  // An explicit skill wins and loads alone.
  const forced = skillContext("/skill:import-sheet export an atlas for godot");
  assert.deepEqual(forced.used, ["import-sheet"]);
  assert.ok(!forced.context.includes("<skill name=\"export-game\""));
  // A multi-stage request leads with Studio.
  assert.equal(primary("Make a game-ready sprite from scratch to export, end to end"), "studio");
});

test("prompt size: one primary skill instead of every match (#100)", () => {
  const msg = "Export an atlas for Godot";
  const all = [...allSkills().values()].filter((s) => s.triggers.some((t) => msg.toLowerCase().includes(t)));
  const before = all.reduce((n, s) => n + Math.min(s.body.length, INLINE_SKILL_CHARS), 0);
  const after = skillContext(msg).context.length;
  assert.ok(all.length >= 2 && after < before, `${after} chars now vs about ${before} with every match`);
});
