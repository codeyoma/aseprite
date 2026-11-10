// What a tool is (the Tool interface, its results, and the seam to
// Aseprite), shared by tools.ts and every *_tools.ts module. Kept apart from
// tools.ts so tool modules can import it without an import cycle.
import type * as z from "zod/v4";
import type { Reply } from "./aseprite.js";
import { SavedCommands } from "./saved_commands.js";
import type { SubResult, SubTask } from "./subagents.js";

/** The seam tools use to reach Aseprite: AsepriteLink in the bridge, a fake in tests. */
export interface AsepriteRequester {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Reply>;
}

/** Runs spawn_agents' sub-tasks (SubAgents in the bridge, a fake in tests). */
export interface SubAgentRunner {
  run(tasks: SubTask[], parallel?: number): Promise<SubResult[]>;
}

/**
 * Everything a tool may use, built once per MCP server or CLI call. It is an
 * AsepriteRequester, so tools that only talk to Aseprite take it as one.
 */
export interface ToolContext extends AsepriteRequester {
  /** The Saved Commands store (save_command and friends). */
  commands: SavedCommands;
  /** Sub-agents for spawn_agents; absent where they can't run (CLI, sub-agents themselves). */
  subAgents?: SubAgentRunner;
}

/** A ToolContext over `aseprite`; the commands store defaults to the user's folder. */
export function toolContext(
  aseprite: AsepriteRequester,
  opts: { commands?: SavedCommands; subAgents?: SubAgentRunner } = {},
): ToolContext {
  return {
    request: (method, params, timeoutMs) => aseprite.request(method, params, timeoutMs),
    commands: opts.commands ?? new SavedCommands(),
    subAgents: opts.subAgents,
  };
}

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  /** "edit" changes the document; "read" does not. */
  kind: "edit" | "read";
  /** Short description of a call, shown as a step in the chat panel. */
  label(input: any): string;
  /** Custom behaviour; omitted for tools that forward to Aseprite as-is. */
  run?(input: any, ctx: ToolContext): Promise<ToolResult>;
  /** Timeout for forwarded requests. */
  timeoutMs?: number;
}

export function text(value: unknown): Content {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

export function failure(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}
