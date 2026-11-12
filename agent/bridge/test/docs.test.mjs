// Checks that the docs under agent/ still match the code they describe:
// the README tool table, built-in command counts, and file names in GLOSSARY.md.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../dist/tools.js";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(AGENT, "..");
const read = (rel) => readFileSync(join(AGENT, rel), "utf8");
const backticked = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

/** Rows of the table under the README's "## Tools" heading. */
function readmeToolRows() {
  const readme = read("README.md");
  const start = readme.indexOf("\n## Tools\n");
  assert.ok(start >= 0, "README has a ## Tools section");
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  return section.split("\n").filter((l) => l.startsWith("| `"));
}

test("README tool table lists exactly the tools in TOOLS", () => {
  const documented = new Set(readmeToolRows().flatMap((row) => backticked(row.split("|")[1])));
  const registered = new Set(TOOLS.map((t) => t.name));
  const missing = [...registered].filter((n) => !documented.has(n));
  const unknown = [...documented].filter((n) => !registered.has(n));
  assert.deepEqual(missing, [], "tools missing from the README table");
  assert.deepEqual(unknown, [], "README table names tools that do not exist");
});

test("docs do not state a number of built-in commands", () => {
  // The count lives in commands.json; a number in prose goes stale.
  const count = JSON.parse(read("bridge/src/commands.json")).length;
  assert.ok(count > 0);
  for (const file of ["README.md", "docs/PLAN.md", "bridge/README.md"]) {
    if (!existsSync(join(AGENT, file))) continue;
    const hits = read(file).match(/\b\d{2,}\s+(?:built-in\s+)?(?:Aseprite\s+)?commands\b/gi) ?? [];
    assert.deepEqual(hits, [], `${file}: say "every built-in command" instead of a count (now ${count})`);
  }
});

/** Every file and directory under agent/, by base name (node_modules and dist skipped). */
function agentFileNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      names.add(e.name);
      if (e.isDirectory()) walk(join(dir, e.name));
    }
  };
  walk(AGENT);
  return names;
}

test("GLOSSARY file paths exist", () => {
  const names = agentFileNames();
  const bad = [];
  for (const raw of new Set(backticked(read("GLOSSARY.md")))) {
    if (raw.startsWith("~/")) continue; // user files (~/.aseprite-agent/...), not in the repo
    if (raw.startsWith("agent/")) {
      // `agent/skills/<name>/SKILL.md`: check the part before the first placeholder.
      const path = raw.split(/[<*]/)[0].replace(/\/$/, "");
      if (!existsSync(join(REPO, path))) bad.push(raw);
    } else if (/^[\w-]+(\.[\w-]+)*\.(ts|mjs|js|lua|json|md|sh)$/.test(raw)) {
      // A bare file name (`tool_modules.ts`): some file under agent/ has it.
      if (!names.has(raw)) bad.push(raw);
    }
  }
  assert.deepEqual(bad, [], "GLOSSARY names files that do not exist");
});

test("one way to edit the timeline: the chat rules, the guide and the skills name timeline text, never apply's frame ops (#113)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { systemPrompt } = await import("../dist/chat.js");
  const root = new URL("../../", import.meta.url);
  const skills = readdirSync(new URL("skills/", root)).map((d) => { try { return readFileSync(new URL(`skills/${d}/SKILL.md`, root), "utf8"); } catch { return ""; } });
  const texts = [systemPrompt(), readFileSync(new URL("guide/basics.md", root), "utf8"), ...skills];
  for (const t of texts) assert.doesNotMatch(t, /\b(add_frames|delete_frames|set_duration|set_tag|delete_tag)\b/, "frame and tag edits go through apply_timeline_text");
  assert.match(systemPrompt(), /The timeline \(frame counts, durations, tags, linked cels\) is edited as text: get_timeline_text, then apply_timeline_text/);
  assert.match(systemPrompt(), /<skills-index>\n- pixel-art: /);
});
