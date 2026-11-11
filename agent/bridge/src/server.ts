// The MCP server, shared by the stdio and HTTP transports. Tools come from
// the Tool table (tools.ts): the core set is listed and the rest is reached
// through find_tools and call_tool (tool_sets.ts, #88); resources are the pixel-art rule chapters
// (rules://<chapter>, rules.ts) and the skills (skill://<name>), read only
// when a client asks for one; prompts are the skills (skill_mcp.ts).

import { McpServer } from "@modelcontextprotocol/server";
import { ruleChapters } from "./rules.js";
import { registerSkills } from "./skill_mcp.js";
import { runTool, TOOLS, type Tool, type ToolContext } from "./tools.js";
import { listedTools, metaTools, toolSetMode, type ToolSetMode } from "./tool_sets.js";

export const VERSION = "0.4.0";

export const INSTRUCTIONS = `
You control a running Aseprite (pixel-art and animation editor) through these tools.

Workflow:
1. Before your first edit in a session, call read_guide("basics"). Use read_guide("recipes") for tested
   snippets (pixelate, retime, idle animation, outline, sprite sheet export) and read_guide("pixel-art") when drawing.
   Numeric pixel-art rules (timing tables, proportions, tiles, isometric, effects, UI) are in read_guide("rules").
2. Call get_state to see the document and get_context to see what the user has selected.
3. Make changes with apply (layers, cels, pixels, rects, lines, frames, tags and palette as a list of ops: one undo
   step, dry_run to check first) or execute_lua for anything else. Each call is one undo step and rolls back on error.
   Pass look: true and check: true to get the snapshot and the check findings with the edit.
4. Call snapshot after visual changes and check the result. Use read_pixels for exact pixel work, and write_pixels to write its rows back after changing keys.
5. Your tool list holds the core tools. The others (palettes, shading, outlines, dithering, animation helpers, timeline
   text, effects, tiles, UI, export, image generation, run_command for Aseprite commands, ...) are found with
   find_tools and run with call_tool({ name, input }). Skills list the inputs of the tools they use.

Aseprite Lua essentials:
- Globals: app, Sprite, Image, Color, Point, Rectangle, Size, Palette, ColorMode, json.
- app.sprite / app.layer / app.frame / app.cel are the active objects (may be nil).
- Frames and layer stack indices are 1-based. sprite.layers is bottom to top.
- A cel is the image of one layer in one frame: layer:cel(frame) or sprite:newCel(layer, frame, image, Point(x, y)).
- cel.image is positioned at cel.position; edit a copy and assign it back, or draw with image:drawPixel(x, y, color).
- Edit cel images undoably: img = cel.image:clone(); edit img; cel.image = img. Direct drawPixel on cel.image is not undoable.
- Cel images are trimmed: cel.position is their top-left in sprite coordinates.
- Color("#ff0000") does not parse hex; use Color(255, 0, 0).
- Any menu command: run_command through call_tool (discover names and parameters with list_commands), or in Lua
  app.command.CommandName{ param = value, ui = false }.
- Tools: app.tool = "pencil"; app.useTool{ tool="pencil", color=Color(255,0,0), points={Point(0,0), Point(4,4)} }.
- Frame duration is in seconds: sprite.frames[i].duration = 0.1.
- Pass ui=false to commands so no modal dialog blocks the agent.
`.trim();

export const READ_ONLY_NOTE =
  "This connection is read-only (Ask or Plan mode): only tools that read the document are available. " +
  "Do not try to change the document; describe or plan changes instead.";

/** Tools that start agents, left out for critics. */
const AGENT_TOOLS = new Set(["spawn_agents", "critique", "ab_compare", "motion_review"]);

export interface McpServerOptions {
  readOnly?: boolean;
  subAgent?: boolean;
  critic?: boolean;
  /** "core" lists the core tools plus find_tools and call_tool; "all" lists every tool. Default: ASEPRITE_AGENT_TOOLS. */
  tools?: ToolSetMode;
}

/**
 * The tools a server allows: readOnly only the read tools (Ask and Plan
 * modes); subAgent leaves out spawn_agents; critic (with readOnly) also
 * critique and ab_compare.
 */
export function availableTools(opts: McpServerOptions = {}): Tool[] {
  return TOOLS.filter((tool) => {
    if (opts.readOnly && tool.kind !== "read") return false;
    // Sub-agents don't start more sub-agents.
    if (opts.subAgent && tool.name === "spawn_agents") return false;
    // Critics (#76) don't start agents either.
    if (opts.critic && AGENT_TOOLS.has(tool.name)) return false;
    return true;
  });
}

/** The tools a server lists (#88): the core ones (or all) plus find_tools and call_tool over every allowed tool. */
export function serverTools(opts: McpServerOptions = {}): Tool[] {
  const available = availableTools(opts);
  return [...listedTools(available, opts.tools ?? toolSetMode()), ...metaTools(available)];
}

/** The MCP server over one ToolContext; serverTools says which tools it lists. */
export function createMcpServer(ctx: ToolContext, opts: McpServerOptions = {}): McpServer {
  const instructions = opts.readOnly ? `${INSTRUCTIONS}\n\n${READ_ONLY_NOTE}` : INSTRUCTIONS;
  const server = new McpServer({ name: "aseprite-agent", version: VERSION }, { instructions });
  for (const tool of serverTools(opts)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input },
      (input: any) => runTool(tool, input, ctx) as any,
    );
  }
  registerRuleResources(server);
  // Read-only endpoints (Ask and Plan) keep the skill resources but not the
  // prompts: a prompt asks the agent to carry out a workflow that edits.
  registerSkills(server, { prompts: !opts.readOnly });
  return server;
}

/** One MCP resource per rule chapter: rules://animation, rules://tiles, ... */
export function registerRuleResources(server: McpServer): void {
  for (const c of ruleChapters()) {
    server.registerResource(
      `rules-${c.name}`,
      `rules://${c.name}`,
      { title: c.title, description: `${c.description} Rule ids start with ${c.id}.`, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: c.body }] }),
    );
  }
}
