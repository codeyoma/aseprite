// Guide tools: the agent guide's topics and the Skill Catalog.
import * as z from "zod/v4";
import { allSkills, catalog, guideIndex, guideTopics, readGuide, searchCatalog } from "./guide.js";
import { skillToolsNote } from "./tool_sets.js";
import { readRule, ruleChapter, ruleChapters, rulesIndex } from "./rules.js";
import { failure, text, type Tool } from "./tool.js";

/** A rules topic: "rules", "rules/<chapter>", or a rule id ("anim.timing.walk", "rule:anim.timing.walk"). */
export function readRulesTopic(topic: string): string | undefined {
  const t = topic.trim().toLowerCase();
  if (t === "rules" || t === "rules/") return rulesIndex();
  const chapter = /^rules\/([\w.-]+)$/.exec(t)?.[1];
  if (chapter) return ruleChapter(chapter)?.body ?? readRule(chapter);
  if (t.startsWith("rule:") || t.includes(".")) return readRule(t);
  return undefined;
}

export const GUIDE_TOOLS: Tool[] = [
  {
    name: "read_guide",
    title: "Read the Aseprite agent guide",
    description:
      "Read a guide topic: 'basics' (API rules that prevent bugs; read before the first edit), 'recipes' (tested " +
      "Lua snippets for common tasks), 'pixel-art' (style rules and working loop), or one of the user's own skills. " +
      "Pixel-art rules (numeric tables, mistakes, review lists, write_pixels templates): 'rules' lists the chapters " +
      "and rule ids, 'rules/<chapter>' reads one (animation, characters, tiles, isometric, vfx, ui), and a rule id " +
      "such as 'anim.timing.walk' reads one section. Call with no topic to list topics and skills.",
    input: z.object({ topic: z.string().optional() }),
    kind: "read",
    label: (i) => `Read guide${i?.topic ? `: ${i.topic}` : ""}`,
    async run({ topic }) {
      const topics = guideTopics();
      if (!topic) {
        const chapters = ruleChapters().map((c) => `rules/${c.name}`).join(", ");
        return { content: [text(`Topics:\n${guideIndex()}\n\nRules (read_guide("rules") lists rule ids): ${chapters}`)] };
      }
      const md = readGuide(topic) ?? readRulesTopic(topic);
      if (md === undefined) {
        return failure(`Unknown topic: ${topic}. Topics: ${topics.join(", ")}; rules: ${ruleChapters().map((c) => `rules/${c.name}`).join(", ")}`);
      }
      // A skill's deferred tools with their inputs (#88), so following it needs no find_tools call.
      const tools = skillToolsNote(allSkills().get(topic.toLowerCase())?.tools ?? []);
      return { content: [text(tools ? `${md.trimEnd()}\n\n${tools}` : md)] };
    },
  },
  {
    name: "list_skills",
    title: "List skills",
    description:
      "The skill catalog: built-in skills, guide topics and the user's own skills, with title, category and what " +
      "each needs. Read a skill's instructions with read_guide(name) before following it. The list ends with the " +
      "pixel-art rule chapters (read_guide(\"rules/<chapter>\")), which skills cite as rule:<id>.",
    input: z.object({ query: z.string().optional().describe("Words to filter by, e.g. 'palette'.") }),
    kind: "read",
    label: () => "List skills",
    async run({ query }) {
      const rows = query ? searchCatalog(query) : catalog();
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const chapters = ruleChapters().filter((c) =>
        words.every((w: string) => `rules ${c.name} ${c.id} ${c.title} ${c.description}`.toLowerCase().includes(w)));
      if (!rows.length && !chapters.length) return { content: [text(`No skills match "${query}".`)] };
      const lines = rows.map((r) =>
        `- ${r.name}: ${r.title} [${r.category}, ${r.source}]${r.needs.length ? ` needs ${r.needs.join(", ")}` : ""}. ${r.description}`);
      if (chapters.length) {
        lines.push("Rules (read_guide(\"rules/<chapter>\"), resource rules://<chapter>):",
          ...chapters.map((c) => `- rules/${c.name}: ${c.title} [${c.id}, ${c.rules.length} rules]. ${c.description}`));
      }
      return { content: [text(lines.join("\n"))] };
    },
  },
];
