// The pixel-art knowledge base (#77): rule chapters in agent/guide/rules/*.md,
// served on demand through read_guide ("rules", "rules/<chapter>", a rule id)
// and the MCP resources rules://<chapter>. They are not skills: guide.ts only
// reads the guide folder's top level, so rules never match a trigger or get
// inlined into a prompt.
//
// A chapter is a markdown file whose H1 carries the chapter id, e.g.
// "# Animation timing {#anim}". Rule ids sit on H2/H3 headings
// ("## Walk {#anim.timing.walk}"); a rule's text runs to the next heading of
// the same or a higher level. Skills and guide topics cite a rule as
// `rule:<id>` (in backticks). Grid templates are ```grid blocks: a
// "Legend: k=#hex ..." line, then rows in the write_pixels format.
//
// Adapted from aseprite-ai-artist's rules/ (MIT License, Copyright (c) 2026
// with-pebbly, https://github.com/with-pebbly/aseprite-ai-artist); see
// agent/guide/rules/CREDITS.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RULES_DIR = [new URL("../guide/rules/", import.meta.url), new URL("../../guide/rules/", import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => existsSync(dir));

/** The citation syntax in skills and guide topics: `rule:anim.timing.walk`. */
export const RULE_CITATION = /`rule:([a-z0-9][a-z0-9.-]*)`/g;
const HEADING = /^(#{1,3})\s+(.*?)\s*\{#([a-z0-9][a-z0-9.-]*)\}\s*$/;

export interface RuleChapter {
  /** File name without .md, e.g. "animation"; the topic is rules/<name>. */
  name: string;
  /** The H1's id, e.g. "anim"; every rule id in the chapter starts with it. */
  id: string;
  title: string;
  /** The first paragraph after the H1. */
  description: string;
  body: string;
  /** Rule ids in order, with their heading text. */
  rules: { id: string; title: string }[];
}

export interface GridTemplate {
  /** The rule id of the heading the block sits under. */
  id: string;
  legend: string;
  rows: string[];
}

export function parseChapter(name: string, body: string): RuleChapter | undefined {
  const lines = body.split(/\r?\n/);
  const h1 = lines.map((l) => HEADING.exec(l)).find((m) => m && m[1] === "#");
  if (!h1) return undefined;
  const rules = lines
    .map((l) => HEADING.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== "#")
    .map((m) => ({ id: m[3], title: m[2] }));
  const afterH1 = body.slice(body.indexOf(h1[0]) + h1[0].length).trim();
  const description = afterH1.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").split(". Cite")[0].trim() ?? "";
  return { name, id: h1[3], title: h1[2], description, body, rules };
}

/** Every chapter, by file name order. Files without an H1 id (CREDITS.md) are not chapters. */
export function ruleChapters(dir = RULES_DIR): RuleChapter[] {
  if (!dir) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return files
    .map((f) => parseChapter(f.slice(0, -3), readFileSync(join(dir, f), "utf8")))
    .filter((c): c is RuleChapter => !!c);
}

export function ruleChapter(name: string, chapters = ruleChapters()): RuleChapter | undefined {
  const n = name.toLowerCase().replace(/\.md$/, "");
  return chapters.find((c) => c.name === n || c.id === n);
}

/** Every rule id (chapter ids included). */
export function ruleIds(chapters = ruleChapters()): Set<string> {
  return new Set(chapters.flatMap((c) => [c.id, ...c.rules.map((r) => r.id)]));
}

/** One rule's section: its heading and text up to the next heading of the same or a higher level. */
export function readRule(id: string, chapters = ruleChapters()): string | undefined {
  const want = id.replace(/^rule:/, "").toLowerCase();
  for (const c of chapters) {
    if (c.id === want) return c.body;
    const lines = c.body.split(/\r?\n/);
    const start = lines.findIndex((l) => HEADING.exec(l)?.[3] === want);
    if (start < 0) continue;
    const level = HEADING.exec(lines[start])![1].length;
    let end = start + 1;
    let fenced = false;
    for (; end < lines.length; end++) {
      if (lines[end].startsWith("```")) fenced = !fenced;
      const h = !fenced && /^(#{1,6})\s/.exec(lines[end]);
      if (h && h[1].length <= level) break;
    }
    return `${lines.slice(start, end).join("\n").trim()}\n\n(From rules/${c.name}.)`;
  }
  return undefined;
}

/** The text for read_guide("rules"): chapters with their rule ids. */
export function rulesIndex(chapters = ruleChapters()): string {
  return [
    "Pixel-art rules. Read a chapter with read_guide(\"rules/<chapter>\") (or the MCP resource rules://<chapter>), " +
      "one rule with read_guide(\"<rule id>\"). Cite rules as `rule:<id>`.",
    ...chapters.map((c) => `- rules/${c.name} (${c.id}): ${c.description}\n  ${c.rules.map((r) => r.id).join(", ")}`),
  ].join("\n");
}

/** The ```grid blocks of a chapter, each under the rule heading above it. */
export function gridTemplates(chapter: RuleChapter): GridTemplate[] {
  const out: GridTemplate[] = [];
  let id = chapter.id;
  let block: string[] | undefined;
  for (const line of chapter.body.split(/\r?\n/)) {
    if (block) {
      if (line.startsWith("```")) {
        const [legend, ...rows] = block;
        out.push({ id, legend: legend ?? "", rows });
        block = undefined;
      } else block.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) id = h[3];
    else if (/^```grid\s*$/.test(line)) block = [];
  }
  return out;
}

/** Rule ids cited (`rule:<id>`) in a text. */
export function citedRules(text: string): string[] {
  return [...text.matchAll(RULE_CITATION)].map((m) => m[1]);
}
