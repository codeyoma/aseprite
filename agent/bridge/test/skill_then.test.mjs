// Skill chains (#78): every built-in skill ends with one "Then:" line naming
// the usual next skill, and every name it gives is a built-in skill or a
// guide topic, so studio's chains and the hand-offs never point at nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// No user skills: only what ships counts.
process.env.ASEPRITE_AGENT_SKILLS = mkdtempSync(join(tmpdir(), "skills-then-"));
const { allSkills } = await import("../dist/guide.js");

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const names = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory()).sort();
const known = new Set([...allSkills().values()].filter((s) => s.source !== "user").map((s) => s.name));

/** The "Then:" lines of a skill's markdown and the backticked names on them. */
function thenLines(md) {
  return md.split(/\r?\n/).filter((l) => /^Then:\s/.test(l)).map((line) => ({ line, names: [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]) }));
}

test("every built-in skill has exactly one Then line naming existing skills", () => {
  assert.ok(names.includes("brief") && names.includes("studio"));
  const bad = [];
  for (const name of names) {
    const lines = thenLines(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"));
    if (lines.length !== 1) { bad.push(`${name}: ${lines.length} Then lines`); continue; }
    const [{ line, names: next }] = lines;
    if (!next.length) bad.push(`${name}: no skill named in "${line}"`);
    for (const n of next) if (!known.has(n)) bad.push(`${name}: unknown skill \`${n}\` in "${line}"`);
  }
  assert.deepEqual(bad, []);
});

test("Then lines are parsed from backticks only", () => {
  assert.deepEqual(thenLines("x\nThen: `review`, then `export-game`.\nthen: `no`"), [{ line: "Then: `review`, then `export-game`.", names: ["review", "export-game"] }]);
});
