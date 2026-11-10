// The agent guide and skills. Built-in topics are agent/guide/*.md (bundled
// in the npm package as ../guide, or read from the repository as
// ../../guide). User skills are ~/.aseprite-agent/skills/<name>.md
// (ASEPRITE_AGENT_SKILLS overrides the folder), with optional frontmatter:
//
//   ---
//   name: dithering
//   description: Ordered dithering rules for 16-color sprites
//   triggers: [dither, gradient, shading]
//   ---
//
// A user skill with the same name as a built-in topic replaces it for the
// agent; the built-in files are never changed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDir } from "./session.js";

const GUIDE_DIR =
  [new URL("../guide/", import.meta.url), new URL("../../guide/", import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../guide/", import.meta.url));

export function skillsDir(): string {
  return process.env.ASEPRITE_AGENT_SKILLS ?? join(sessionDir, "skills");
}

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  body: string; // markdown without frontmatter
  source: "built-in" | "user";
}

/** Splits optional YAML-ish frontmatter (name, description, triggers) from the body. */
export function parseSkill(text: string, fallbackName: string, source: Skill["source"]): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let listKey: string | undefined;
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s+-\s*(.+)$/.exec(line);
      if (item && listKey) {
        lists[listKey].push(unquote(item[1]));
        continue;
      }
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const [, key, value] = kv;
      listKey = undefined;
      if (value.startsWith("[")) lists[key] = value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
      else if (value === "") {
        lists[key] = [];
        listKey = key;
      } else meta[key] = unquote(value);
    }
  }
  const body = m ? text.slice(m[0].length) : text;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];
  return {
    name: (meta.name ?? fallbackName).toLowerCase(),
    description: meta.description ?? heading ?? "",
    triggers: (lists.triggers ?? []).map((t) => t.toLowerCase()),
    body,
    source,
  };
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "").trim();
}

function readDir(dir: string, source: Skill["source"]): Skill[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const f of files) {
    try {
      out.push(parseSkill(readFileSync(join(dir, f), "utf8"), f.slice(0, -3).toLowerCase(), source));
    } catch {
      // unreadable file: skip it
    }
  }
  return out;
}

/** Built-in topics and user skills by name; user skills win. */
export function allSkills(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  for (const s of readDir(GUIDE_DIR, "built-in")) map.set(s.name, s);
  for (const s of readDir(skillsDir(), "user")) map.set(s.name, s);
  return map;
}

export function guideTopics(): string[] {
  return [...allSkills().keys()].sort();
}

/** One line per topic, for read_guide with no topic. */
export function guideIndex(): string {
  return [...allSkills().values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}${s.source === "user" ? " (your skill)" : ""}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

/** The topic's markdown, or undefined for an unknown topic. */
export function readGuide(topic: string): string | undefined {
  const s = allSkills().get(topic.toLowerCase().replace(/\.md$/, ""));
  return s?.body;
}

/** Skills inlined into a message are capped at this many characters; longer ones get a hint. */
export const INLINE_SKILL_CHARS = 2000;

/**
 * What a chat message adds for skills: "/skill:name rest" forces a skill,
 * and user skills whose trigger words appear in the message are suggested
 * (inlined when short). Returns the message without the /skill prefix and
 * the text to add before it.
 */
export function skillContext(message: string, skills = allSkills()): { message: string; context: string; used: string[] } {
  const parts: string[] = [];
  const used: string[] = [];
  let rest = message;
  const forced = /^\s*\/skill:([\w-]+)\s*/.exec(message);
  if (forced) {
    rest = message.slice(forced[0].length);
    const s = skills.get(forced[1].toLowerCase());
    if (s) {
      parts.push(`<skill name="${s.name}" note="the user asked you to follow this skill">\n${s.body.trim()}\n</skill>`);
      used.push(s.name);
    } else {
      parts.push(`(The user asked for a skill named "${forced[1]}", but there is none. Skills: ${[...skills.keys()].join(", ")}.)`);
    }
  }
  const words = rest.toLowerCase();
  for (const s of skills.values()) {
    if (used.includes(s.name) || !s.triggers.length) continue;
    const hit = s.triggers.find((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, "u").test(words));
    if (!hit) continue;
    used.push(s.name);
    if (s.body.length <= INLINE_SKILL_CHARS) {
      parts.push(`<skill name="${s.name}" note="matched '${hit}'; follow it where it applies">\n${s.body.trim()}\n</skill>`);
    } else {
      parts.push(`Relevant skill: ${s.name}${s.description ? ` (${s.description})` : ""}. Call read_guide("${s.name}") before you start.`);
    }
  }
  return { message: rest, context: parts.join("\n"), used };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
