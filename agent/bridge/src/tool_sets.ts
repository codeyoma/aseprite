// The default tool set (#88): an MCP client lists about 15 core tools; the
// rest of the Tool table stays callable through two meta tools, find_tools
// (search, with each tool's inputs) and call_tool (run one by name). Fewer,
// smaller tool definitions in every model call, and fewer calls that fail on
// a tool name. Skills that use deferred tools carry their signatures in the
// skill text (skillToolsNote), so a skill run needs no find_tools call.
//
// Dispatch instead of dynamic registration (tools/list_changed): the chat's
// HTTP endpoint is stateless (one MCP server per request) and not every
// client re-lists tools, so the listed set must be fixed per server.
// ASEPRITE_AGENT_TOOLS=all lists every tool, as before. The CLI and the
// tests use the Tool table directly and see every tool.
import * as z from "zod/v4";
import { failure, text, type Tool } from "./tool.js";
import { findTool, runTool, TOOLS } from "./tools.js";

/**
 * The core tools: listed by default. Read the document, look and check, edit
 * (apply first, execute_lua as the fallback, the pixel grid), undo, the guide,
 * and the chat's own steps (ask the user, show variations). The meta tools
 * find_tools and call_tool are listed with them (15 in all).
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "get_state", "get_context", "apply", "execute_lua", "snapshot", "check", "read_pixels", "write_pixels",
  "undo", "redo", "read_guide", "ask_user", "propose_variations",
];

export const META_TOOL_NAMES = ["find_tools", "call_tool"] as const;

export type ToolSetMode = "core" | "all";

/** ASEPRITE_AGENT_TOOLS: "all" lists every tool; anything else the core set. */
export function toolSetMode(env: NodeJS.ProcessEnv = process.env): ToolSetMode {
  return env.ASEPRITE_AGENT_TOOLS?.trim().toLowerCase() === "all" ? "all" : "core";
}

export function isCore(name: string): boolean {
  return CORE_TOOL_NAMES.includes(name) || (META_TOOL_NAMES as readonly string[]).includes(name);
}

/** A JSON Schema node as a short type: string, integer 1-32, a|b, [integer], {x, y}. */
function typeText(s: any, depth = 0): string {
  if (!s || typeof s !== "object") return "any";
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join("|");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return alts.map((a: any) => typeText(a, depth)).join("|");
  if (s.type === "array") return s.prefixItems ? `[${s.prefixItems.map((a: any) => typeText(a, depth)).join(", ")}]` : `[${typeText(s.items, depth)}]`;
  if (s.type === "object") {
    const props = Object.keys(s.properties ?? {});
    if (!props.length || depth > 0) return "object";
    const req = new Set<string>(s.required ?? []);
    return `{${props.map((k) => `${k}${req.has(k) ? "" : "?"}: ${typeText(s.properties[k], depth + 1)}`).join(", ")}}`;
  }
  if (s.type === "integer" || s.type === "number") {
    const lo = s.minimum, hi = s.maximum;
    const big = (v: unknown) => typeof v === "number" && Math.abs(v) >= 2 ** 31;
    const range = lo !== undefined && hi !== undefined && !big(lo) && !big(hi) ? ` ${lo}-${hi}` : "";
    return `${s.type}${range}`;
  }
  return String(s.type ?? "any");
}

/** The tool's input JSON Schema (as MCP lists it). */
export function inputSchema(tool: Tool): any {
  const { $schema, ...rest } = z.toJSONSchema(tool.input, { unrepresentable: "any" }) as any;
  return rest;
}

/** One line per tool input: `name {a: string, b?: integer 1-32}`. */
export function toolSignature(tool: Tool): string {
  const s = inputSchema(tool);
  const props = Object.keys(s.properties ?? {});
  if (!props.length) return `${tool.name} {}`;
  const req = new Set<string>(s.required ?? []);
  return `${tool.name} {${props.map((k) => `${k}${req.has(k) ? "" : "?"}: ${typeText(s.properties[k], 1)}`).join(", ")}}`;
}

/** The description's first sentence, at most 160 characters. */
export function summary(tool: Tool): string {
  const first = /^(.+?[.!?])(\s|$)/s.exec(tool.description)?.[1] ?? tool.description;
  const one = first.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

/** A catalog line: signature and summary. */
export function catalogLine(tool: Tool): string {
  return `- ${toolSignature(tool)}: ${summary(tool)}`;
}

/** The tools an MCP server lists: all of `available`, or its core ones. */
export function listedTools(available: Tool[], mode: ToolSetMode): Tool[] {
  if (mode === "all") return available;
  const byName = new Map(available.map((t) => [t.name, t]));
  return CORE_TOOL_NAMES.map((n) => byName.get(n)).filter((t): t is Tool => !!t);
}

/**
 * What a text (a skill, the system prompt) needs beside the core set: the
 * signatures of the deferred tools it names, and how to call them. "" when
 * every named tool is core (or unknown).
 */
export function deferredToolsNote(names: Iterable<string>, intro = "Tools named here that are not in your tool list"): string {
  if (toolSetMode() === "all") return "";
  const tools = [...new Set(names)].filter((n) => !isCore(n)).map((n) => findTool(n)).filter((t): t is Tool => !!t);
  if (!tools.length) return "";
  return `${intro}: call them with call_tool, e.g. call_tool({ name: "${tools[0].name}", input: { ... } }). Their inputs:\n` +
    tools.map(catalogLine).join("\n");
}

/** A skill's deferred tools with their inputs (#88), for the skill's text; "" when none or every tool is listed. */
export function skillToolsNote(names: Iterable<string>): string {
  const note = deferredToolsNote(names, "Tools this skill uses that are not in your tool list");
  return note ? `<skill-tools>\n${note}\n</skill-tools>` : "";
}

/** Tool names a text mentions (word matches against the Tool table). */
export function toolsNamedIn(text: string): string[] {
  return TOOLS.map((t) => t.name).filter((n) => new RegExp(`\\b${n}\\b`).test(text));
}

/** find_tools' ranking: name and title hits count most, then description words. */
function score(tool: Tool, words: string[]): number {
  const name = tool.name.toLowerCase(), title = tool.title.toLowerCase(), desc = tool.description.toLowerCase();
  let n = 0;
  for (const w of words) {
    if (name === w) n += 10;
    else if (name.includes(w)) n += 5;
    if (title.includes(w)) n += 3;
    if (desc.includes(w)) n += 1;
  }
  return n;
}

/**
 * find_tools and call_tool over `available` (the tools this server allows:
 * read-only endpoints offer read tools only, sub-agents no spawn_agents).
 * call_tool checks the input against the tool's schema before running it.
 */
export function metaTools(available: Tool[]): Tool[] {
  const byName = new Map(available.map((t) => [t.name, t]));
  const findTools: Tool = {
    name: "find_tools",
    title: "Find tools",
    description:
      "Search the tools that are not in your tool list (palettes and ramps, shading, outlines, dithering, animation " +
      "helpers, timeline text, effects, tiles, UI, export, sprite sheets, image generation, Aseprite commands, critics, " +
      "sub-agents...). query: words to match; names: exact tool names to get their full input schema. Run a found " +
      "tool with call_tool.",
    input: z.object({
      query: z.string().optional().describe("Words to search names and descriptions, e.g. 'outline' or 'sprite sheet export'."),
      names: z.array(z.string()).optional().describe("Exact tool names: returns each one's description and full input schema."),
    }),
    kind: "read",
    label: (a) => (a?.names?.length ? `Look up ${a.names.join(", ")}` : a?.query ? `Find tools: ${a.query}` : "Find tools"),
    async run({ query, names }) {
      const parts: string[] = [];
      for (const n of names ?? []) {
        const t = byName.get(n);
        if (!t) { parts.push(`${n}: no such tool here.`); continue; }
        parts.push(`${t.name} (${t.kind}): ${t.description}\nInput schema: ${JSON.stringify(inputSchema(t))}`);
      }
      const words = String(query ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter((w: string) => w.length > 1);
      if (words.length || !names?.length) {
        const ranked = available
          .filter((t) => !(META_TOOL_NAMES as readonly string[]).includes(t.name))
          .map((t) => ({ t, s: words.length ? score(t, words) : 1 }))
          .filter((r) => r.s > 0)
          .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
          .slice(0, words.length ? 12 : 200);
        parts.push(ranked.length
          ? `${words.length ? "Matching tools" : "All tools"} (call with call_tool({ name, input })):\n${ranked.map((r) => catalogLine(r.t)).join("\n")}`
          : `No tool matches "${query}".`);
      }
      return { content: [text(parts.join("\n\n"))] };
    },
  };
  const callTool: Tool = {
    name: "call_tool",
    title: "Call a tool",
    description:
      "Run any aseprite tool by name, also one not in your tool list (find_tools lists them with their inputs; " +
      "skills give the inputs of the tools they use). input is that tool's input object.",
    input: z.object({
      name: z.string().min(1).describe("The tool's name, e.g. 'make_ramp'."),
      input: z.record(z.string(), z.unknown()).optional().describe("The tool's input. Default {}."),
    }),
    kind: available.some((t) => t.kind === "edit") ? "edit" : "read",
    label: (a) => {
      const t = a?.name ? findTool(String(a.name)) : undefined;
      return t ? t.label(a.input ?? {}) : "Call a tool";
    },
    async run({ name, input }, ctx) {
      if ((META_TOOL_NAMES as readonly string[]).includes(name)) return failure(`Call ${name} directly, not through call_tool.`);
      const tool = byName.get(name);
      if (!tool) {
        const known = findTool(name);
        return failure(known
          ? `${name} is not available here (this connection offers ${available.some((t) => t.kind === "edit") ? "other" : "only read"} tools).`
          : `No tool named "${name}". Search with find_tools.`);
      }
      const parsed = tool.input.safeParse(input ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `- ${["input", ...i.path].map(String).join(".")}: ${i.message}`);
        return failure(`Invalid input for ${name}:\n${issues.join("\n")}\nIts inputs: ${toolSignature(tool)}`);
      }
      return runTool(tool, parsed.data, ctx);
    },
  };
  return [findTools, callTool];
}
