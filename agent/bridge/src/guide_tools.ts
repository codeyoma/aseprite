// Guide tools: the agent guide's topics and the Skill Catalog.
import * as z from "zod/v4";
import { catalog, guideIndex, guideTopics, readGuide, searchCatalog } from "./guide.js";
import { failure, text, type Tool } from "./tool.js";

export const GUIDE_TOOLS: Tool[] = [
  {
    name: "read_guide",
    title: "Read the Aseprite agent guide",
    description:
      "Read a guide topic: 'basics' (API rules that prevent bugs; read before the first edit), 'recipes' (tested " +
      "Lua snippets for common tasks), 'pixel-art' (style rules and working loop), or one of the user's own skills. " +
      "Call with no topic to list topics and skills.",
    input: z.object({ topic: z.string().optional() }),
    kind: "read",
    label: (i) => `Read guide${i?.topic ? `: ${i.topic}` : ""}`,
    async run({ topic }) {
      const topics = guideTopics();
      if (!topic) return { content: [text(`Topics:\n${guideIndex()}`)] };
      const md = readGuide(topic);
      return md === undefined ? failure(`Unknown topic: ${topic}. Topics: ${topics.join(", ")}`) : { content: [text(md)] };
    },
  },
  {
    name: "list_skills",
    title: "List skills",
    description:
      "The skill catalog: built-in skills, guide topics and the user's own skills, with title, category and what " +
      "each needs. Read a skill's instructions with read_guide(name) before following it.",
    input: z.object({ query: z.string().optional().describe("Words to filter by, e.g. 'palette'.") }),
    kind: "read",
    label: () => "List skills",
    async run({ query }) {
      const rows = query ? searchCatalog(query) : catalog();
      if (!rows.length) return { content: [text(`No skills match "${query}".`)] };
      return {
        content: [text(rows.map((r) =>
          `- ${r.name}: ${r.title} [${r.category}, ${r.source}]${r.needs.length ? ` needs ${r.needs.join(", ")}` : ""}. ${r.description}`,
        ).join("\n"))],
      };
    },
  },
];
