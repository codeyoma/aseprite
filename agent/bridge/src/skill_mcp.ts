// Skills as MCP prompts and resources (#84). The Skill Catalog (guide.ts)
// is the one source: built-in skills (agent/skills/<name>/SKILL.md) and user
// skills (~/.aseprite-agent/skills), with a user skill replacing a built-in
// of the same name. Any MCP client gets the workflows without a plugin:
//
// - prompt <name>: the skill's text with a short preamble and an optional
//   `request` argument appended as the user's request;
// - resource skill://<name>: the skill's markdown, listed through one
//   resource template whose list callback reads the catalog on every call.
//
// Guide topics (basics, recipes, pixel-art) stay with read_guide; they are
// not workflows to pick. The idea of serving skills as prompts and skill://
// resources comes from aseprite-ai-artist (MIT, https://github.com/with-pebbly/aseprite-ai-artist).
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { allSkills, type Skill } from "./guide.js";
import { skillToolsNote } from "./tool_sets.js";

/** Built-in and user skills by name (guide topics left out), read fresh each call. */
export function servedSkills(skills = allSkills()): Skill[] {
  return [...skills.values()].filter((s) => s.source !== "guide").sort((a, b) => a.name.localeCompare(b.name));
}

export const SKILL_PREAMBLE =
  "Follow this Aseprite skill with the aseprite-agent tools. Before your first edit, call read_guide(\"basics\"). " +
  "Rules cited as `rule:<id>` are read with read_guide(\"<id>\"), a chapter with read_guide(\"rules/<chapter>\") " +
  "or the resource rules://<chapter>.";

/** The prompt text: preamble, the skill, then the user's request when there is one. */
export function skillPromptText(skill: Skill, request?: string): string {
  const parts = [SKILL_PREAMBLE, `<skill name="${skill.name}">\n${skill.body.trim()}\n</skill>`];
  const tools = skillToolsNote(skill.tools);
  if (tools) parts.push(tools);
  const r = request?.trim();
  if (r) parts.push(`The user's request: ${r}`);
  return parts.join("\n\n");
}

/**
 * Registers one prompt per skill and the skill://{name} resource template.
 * Prompt names are fixed when the server is created (the HTTP endpoints
 * create one per session, stdio once per run); their text and the resource
 * list are read from the catalog on each request, so edits to a user skill
 * show without a restart.
 */
export function registerSkills(server: McpServer, opts: { prompts?: boolean } = {}): void {
  const find = (name: string) => allSkills().get(name.toLowerCase());
  if (opts.prompts !== false) {
    for (const s of servedSkills()) {
      server.registerPrompt(
        s.name,
        {
          title: s.title,
          description: s.description,
          argsSchema: z.object({
            request: z.string().optional().describe("What you want done, appended after the skill as your request."),
          }),
        },
        ({ request }) => {
          const skill = find(s.name) ?? s;
          return {
            description: skill.description,
            messages: [{ role: "user" as const, content: { type: "text" as const, text: skillPromptText(skill, request) } }],
          };
        },
      );
    }
  }
  server.registerResource(
    "skill",
    new ResourceTemplate("skill://{name}", {
      list: () => ({
        resources: servedSkills().map((s) => ({
          uri: `skill://${s.name}`,
          name: s.name,
          title: s.title,
          description: s.description,
          mimeType: "text/markdown",
        })),
      }),
      complete: { name: (value) => servedSkills().map((s) => s.name).filter((n) => n.startsWith(value.toLowerCase())) },
    }),
    { title: "Aseprite skill", description: "A skill's workflow as markdown, e.g. skill://animate.", mimeType: "text/markdown" },
    (uri, variables) => {
      const name = String(Array.isArray(variables.name) ? variables.name[0] : variables.name);
      const skill = find(name);
      if (!skill || skill.source === "guide") {
        throw new Error(`No skill named "${name}". Skills: ${servedSkills().map((s) => s.name).join(", ")}.`);
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill.body }] };
    },
  );
}
