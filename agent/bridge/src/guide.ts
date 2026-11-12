// The agent guide and skills: the Skill Catalog (#35). Guide topics are
// agent/guide/*.md; built-in skills are agent/skills/<name>/SKILL.md (both
// bundled in the npm package, or read from the repository). User skills are ~/.aseprite-agent/skills/<name>.md
// (ASEPRITE_AGENT_SKILLS overrides the folder), with optional frontmatter:
//
//   ---
//   name: dithering
//   description: Ordered dithering rules for 16-color sprites
//   triggers: [dither, gradient, shading]
//   ---
//
// Built-in skills add title, category, needs (e.g. [image]) and tools.
// A user skill with the same name as a guide topic or built-in skill
// replaces it for the agent; the bundled files are never changed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDir } from "./session.js";

const GUIDE_DIR =
  [new URL("../guide/", import.meta.url), new URL("../../guide/", import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../guide/", import.meta.url));

const BUILTIN_DIR =
  [new URL("../skills/", import.meta.url), new URL("../../skills/", import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((dir) => existsSync(dir));

export function skillsDir(): string {
  return process.env.ASEPRITE_AGENT_SKILLS ?? join(sessionDir, "skills");
}

export interface Skill {
  name: string;
  /** Shown in the picker, e.g. "Extract palette" (defaults to the name). */
  title: string;
  description: string;
  category: string;
  triggers: string[];
  /** Inputs the user must give first, e.g. ["image"]. */
  needs: string[];
  /** Tools the skill relies on. */
  tools: string[];
  /**
   * Words that say this skill is the user's intent when its triggers tie with another skill's (#100), e.g. export-game:
   * [export], import-sheet: [import, slice]. A message that names one ranks the skill first.
   */
  intents: string[];
  body: string; // markdown without frontmatter
  source: "guide" | "built-in" | "user";
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
  const name = (meta.name ?? fallbackName).toLowerCase();
  return {
    name,
    title: meta.title ?? heading ?? name,
    description: meta.description ?? heading ?? "",
    category: meta.category ?? (source === "guide" ? "Guide" : "Other"),
    triggers: (lists.triggers ?? []).map((t) => t.toLowerCase()),
    needs: lists.needs ?? (meta.needs ? [meta.needs] : []),
    tools: lists.tools ?? [],
    intents: (lists.intents ?? []).map((t) => t.toLowerCase()),
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

/** Skills as folders with a SKILL.md (built-ins, and user skills laid out the same way). */
function readSkillFolders(dir: string | undefined, source: Skill["source"] = "built-in"): Skill[] {
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const n of names) {
    const file = join(dir, n, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      out.push(parseSkill(readFileSync(file, "utf8"), n.toLowerCase(), source));
    } catch {
      // unreadable: skip
    }
  }
  return out;
}

/** Guide topics, built-in skills and user skills by name; later ones win. */
export function allSkills(): Map<string, Skill> {
  const map = new Map<string, Skill>();
  for (const s of readDir(GUIDE_DIR, "guide")) map.set(s.name, s);
  for (const s of readSkillFolders(BUILTIN_DIR)) map.set(s.name, s);
  for (const s of [...readDir(skillsDir(), "user"), ...readSkillFolders(skillsDir(), "user")]) map.set(s.name, s);
  return map;
}

/** One catalog row: what the picker and list_skills show. */
export interface CatalogEntry {
  name: string;
  title: string;
  description: string;
  category: string;
  source: Skill["source"];
  needs: string[];
}

/** The catalog, sorted by category then title. */
export function catalog(skills = allSkills()): CatalogEntry[] {
  return [...skills.values()]
    .map(({ name, title, description, category, source, needs }) => ({ name, title, description, category, source, needs }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

/** Catalog rows matching a query (every word in the name, title, description or category). */
export function searchCatalog(query: string, entries = catalog()): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  const scored = entries
    .map((e) => {
      const name = `${e.name} ${e.title}`.toLowerCase();
      const all = `${name} ${e.description} ${e.category}`.toLowerCase();
      if (!words.every((w) => all.includes(w))) return undefined;
      const score = words.reduce((s, w) => s + (name.startsWith(w) ? 3 : name.includes(w) ? 2 : 1), 0);
      return { e, score };
    })
    .filter((x): x is { e: CatalogEntry; score: number } => !!x);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.e);
}

export function guideTopics(): string[] {
  return [...allSkills().keys()].sort();
}

/** One line per topic, for read_guide with no topic. */
export function guideIndex(): string {
  return [...allSkills().values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- ${s.name}${s.source === "user" ? " (your skill)" : s.source === "built-in" ? " (skill)" : ""}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

/** The topic's markdown, or undefined for an unknown topic. */
export function readGuide(topic: string): string | undefined {
  const s = allSkills().get(topic.toLowerCase().replace(/\.md$/, ""));
  return s?.body;
}

/**
 * The routed skill is inlined into the message up to this many characters (#113: every built-in skill fits, so the
 * agent starts working without a read_guide round trip); longer user skills get a hint.
 */
export const INLINE_SKILL_CHARS = 9000;

/** One line per built-in and user skill (name: description), for the system prompt's skills index. */
export function skillIndex(skills = allSkills()): string {
  return [...skills.values()].filter((s) => s.name !== "basics" && (s.triggers.length || s.description))
    .map((s) => `- ${s.name}: ${(s.description ?? s.title ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
}

/** How well a skill fits a message: trigger hits (longer phrases count more) and intent words (#100). 0: no trigger. */
export function skillScore(s: Skill, words: string): { score: number; hit?: string } {
  const has = (t: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, "u").test(words);
  const hits = s.triggers.filter(has);
  if (!hits.length) return { score: 0 };
  const score = hits.reduce((n, t) => n + 1 + t.split(/\s+/).length, 0) + 4 * s.intents.filter(has).length;
  return { score, hit: hits.sort((a, b) => b.length - a.length)[0] };
}

/**
 * What a chat message adds for skills (#100). "/skill:name rest" follows that skill; otherwise the skills whose trigger
 * words appear are ranked (skillScore) and the best one is the primary workflow: inlined when short, else read with
 * read_guide. The others that matched are only named, so the agent can read one if the task needs it. Returns the
 * message without the /skill prefix and the text to add before it.
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
  const ranked = [...skills.values()]
    .filter((s) => !used.includes(s.name) && s.triggers.length)
    .map((s) => ({ s, ...skillScore(s, words) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  // Without an explicit skill, the best match leads.
  if (!forced && ranked.length) {
    const { s, hit } = ranked.shift()!;
    used.push(s.name);
    if (s.body.length <= INLINE_SKILL_CHARS) {
      parts.push(`<skill name="${s.name}" note="matched '${hit}'; follow it where it applies">\n${s.body.trim()}\n</skill>`);
    } else {
      parts.push(`Relevant skill: ${s.name}${s.description ? ` (${s.description})` : ""}. Call read_guide("${s.name}") before you start.`);
    }
  }
  const others = ranked.slice(0, 3).map((r) => r.s.name);
  if (others.length) parts.push(`Other skills that may help (read_guide("<name>") if the task needs one): ${others.join(", ")}.`);
  return { message: rest, context: parts.join("\n"), used };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
