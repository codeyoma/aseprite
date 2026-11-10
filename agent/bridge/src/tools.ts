// The Tool table: every MCP tool the bridge offers, from the module registry
// (tool_modules.ts). MCP registration, the chat panel's step labels and the
// edit/read kind all come from here. A tool without `run` forwards its input
// to the Aseprite request method of the same name and returns the result as JSON.
import { TOOL_MODULES } from "./tool_modules.js";
import { failure, text, type Tool, type ToolContext, type ToolResult } from "./tool.js";

export {
  failure, text, toolContext,
  type AsepriteRequester, type Content, type SubAgentRunner, type Tool, type ToolContext, type ToolResult,
} from "./tool.js";
export { formatCheck, formatDiff, formatExecute } from "./core_tools.js";
export { withDefaults } from "./command_tools.js";
export { formatTimelineResult } from "./timeline_tools.js";

export const TOOLS: Tool[] = TOOL_MODULES.flatMap((m) => m.tools);

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/** Runs a tool and turns any failure into an MCP error result. */
export async function runTool(tool: Tool, input: any, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (tool.run) return await tool.run(input ?? {}, ctx);
    const { result } = await ctx.request(tool.name, input ?? {}, tool.timeoutMs);
    return { content: [text(result)] };
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}
