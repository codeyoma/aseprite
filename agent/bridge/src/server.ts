// The MCP server, shared by the stdio and HTTP transports. Tools come from
// the Tool table (tools.ts).

import { McpServer } from "@modelcontextprotocol/server";
import type { AsepriteRequester } from "./tools.js";
import { runTool, TOOLS } from "./tools.js";

export const VERSION = "0.4.0";

export const INSTRUCTIONS = `
You control a running Aseprite (pixel-art and animation editor) through these tools.

Workflow:
1. Before your first edit in a session, call read_guide("basics"). Use read_guide("recipes") for tested
   snippets (pixelate, retime, idle animation, outline, sprite sheet export) and read_guide("pixel-art") when drawing.
2. Call get_state to see the document and get_context to see what the user has selected.
3. Make changes with execute_lua or run_command. Each execute_lua call is one undo step and rolls back on error.
4. Call snapshot after visual changes and check the result. Use read_pixels for exact pixel work.

Aseprite Lua essentials:
- Globals: app, Sprite, Image, Color, Point, Rectangle, Size, Palette, ColorMode, json.
- app.sprite / app.layer / app.frame / app.cel are the active objects (may be nil).
- Frames and layer stack indices are 1-based. sprite.layers is bottom to top.
- A cel is the image of one layer in one frame: layer:cel(frame) or sprite:newCel(layer, frame, image, Point(x, y)).
- cel.image is positioned at cel.position; edit a copy and assign it back, or draw with image:drawPixel(x, y, color).
- Edit cel images undoably: img = cel.image:clone(); edit img; cel.image = img. Direct drawPixel on cel.image is not undoable.
- Cel images are trimmed: cel.position is their top-left in sprite coordinates.
- Color("#ff0000") does not parse hex; use Color(255, 0, 0).
- Any menu command: run_command (discover names and parameters with list_commands), or in Lua
  app.command.CommandName{ param = value, ui = false }.
- Tools: app.tool = "pencil"; app.useTool{ tool="pencil", color=Color(255,0,0), points={Point(0,0), Point(4,4)} }.
- Frame duration is in seconds: sprite.frames[i].duration = 0.1.
- Pass ui=false to commands so no modal dialog blocks the agent.
`.trim();

export const READ_ONLY_NOTE =
  "This connection is read-only (Ask or Plan mode): only tools that read the document are available. " +
  "Do not try to change the document; describe or plan changes instead.";

/** The MCP server. readOnly lists (and so allows) only the read tools (Ask and Plan modes). */
export function createMcpServer(aseprite: AsepriteRequester, opts: { readOnly?: boolean; subAgent?: boolean } = {}): McpServer {
  const instructions = opts.readOnly ? `${INSTRUCTIONS}\n\n${READ_ONLY_NOTE}` : INSTRUCTIONS;
  const server = new McpServer({ name: "aseprite-agent", version: VERSION }, { instructions });
  for (const tool of TOOLS) {
    if (opts.readOnly && tool.kind !== "read") continue;
    // Sub-agents don't start more sub-agents.
    if (opts.subAgent && tool.name === "spawn_agents") continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input },
      (input: any) => runTool(tool, input, aseprite) as any,
    );
  }
  return server;
}
