// MCP tool definitions, shared by the stdio and HTTP transports.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AsepriteLink } from "./aseprite.js";
import { encodeSnapshot } from "./png.js";
import commandCatalog from "./commands.json" with { type: "json" };

interface CommandParam {
  name: string;
  type: string;
  default?: string;
  values?: string[];
  aliases?: string[];
}
interface CommandInfo {
  name: string;
  title: string;
  params: CommandParam[];
}
const COMMANDS = commandCatalog as CommandInfo[];
const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name.toLowerCase(), c]));

// Guide markdown: bundled in the npm package (../guide), or agent/guide
// when running from the repository.
const GUIDE_DIR = [new URL("../guide/", import.meta.url), new URL("../../guide/", import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../guide/", import.meta.url));
function guideTopics(): string[] {
  try {
    return readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

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


export function createMcpServer(link: AsepriteLink): McpServer {
const server = new McpServer(
  { name: "aseprite-agent", version: VERSION },
  { instructions: INSTRUCTIONS },
);

function text(value: unknown) {
  return { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function failure(err: unknown) {
  return { content: [text(err instanceof Error ? err.message : String(err))], isError: true };
}

server.registerTool(
  "get_state",
  {
    title: "Get Aseprite state",
    description:
      "Return the open sprites and, for the active sprite: size, color mode, layer tree (top layer first), " +
      "frames with durations, tags, palette, selection, active layer/frame, current tool and colors.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const { result } = await link.request("get_state");
      return { content: [text(result)] };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "execute_lua",
  {
    title: "Run Lua in Aseprite",
    description:
      "Run Lua code inside Aseprite using its scripting API. By default the code runs in one transaction: " +
      "one undo step, rolled back entirely if it raises an error. `print` output is captured, and the " +
      "chunk's return value is returned as JSON. Use this for any edit: layers, frames, cels, pixels, tags, " +
      "palette, commands (app.command.X{...}), tools (app.useTool), selection and file operations.",
    inputSchema: z.object({
      code: z.string().describe("Lua source. Use `return` to send a value back."),
      label: z.string().optional().describe("Undo history label for this step. Default: 'AI Agent'."),
      transaction: z
        .boolean()
        .optional()
        .describe("Default true. Set false for code that must not run in a transaction, e.g. app.open, app.undo."),
    }),
  },
  async ({ code, label, transaction }) => {
    try {
      const { result } = await link.request("execute_lua", { code, label, transaction }, 120_000);
      const content = [];
      if (result.output?.length) content.push(text("Output:\n" + result.output.join("\n")));
      if (result.ok) {
        content.push(text(result.value === undefined ? "OK (no return value)" : { value: result.value }));
        return { content };
      }
      content.push(text((result.rolledBack ? "Error (changes rolled back):\n" : "Error:\n") + result.error));
      return { content, isError: true };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "snapshot",
  {
    title: "Snapshot sprite",
    description:
      "Render the active sprite (or one layer) at a frame and return it as a PNG, upscaled with nearest-neighbor " +
      "so individual pixels are visible. Use it to check visual results after edits.",
    inputSchema: z.object({
      frame: z.number().int().min(1).optional().describe("1-based frame number. Default: active frame."),
      layer: z.string().optional().describe("Render only this layer (by name). Default: all visible layers."),
      scale: z
        .number()
        .int()
        .min(1)
        .max(32)
        .optional()
        .describe("Upscale factor. Default: largest factor that keeps the image at or under 512 px."),
      background: z
        .string()
        .optional()
        .describe("'checker' (default), 'transparent', or a hex color like '#202020'."),
    }),
  },
  async ({ frame, layer, scale, background }) => {
    try {
      const { result, binary } = await link.request("snapshot", { frame, layer });
      if (!binary) throw new Error("Aseprite sent no pixel data");
      const w = result.width as number;
      const h = result.height as number;
      const autoScale = Math.max(1, Math.floor(512 / Math.max(w, h)));
      const s = scale ?? autoScale;
      const png = encodeSnapshot(binary, w, h, s, background ?? "checker");
      return {
        content: [
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
          text(`${w}x${h} px, frame ${result.frame}${result.layer ? `, layer "${result.layer}"` : ""}, shown at ${s}x`),
        ],
      };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "get_context",
  {
    title: "Get user context",
    description:
      "Return what the user is working on: active layer (with group path), frame, tag and cel bounds; the timeline " +
      "range (selected layers/frames/cels); the pixel selection; the current tool, brush, colors and zoom. " +
      "Use it to resolve requests like 'this layer', 'the selected frames' or 'the selected area'.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const { result } = await link.request("get_context");
      return { content: [text(result)] };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "read_pixels",
  {
    title: "Read pixels",
    description:
      "Read a region of the sprite (or one layer) as a text grid, at most 16384 pixels per call. In indexed sprites " +
      "each pixel is its palette index; in RGB sprites each color gets a short key. A legend maps keys to hex. " +
      "'.' is transparent and '-' is outside the canvas. Rows run top to bottom starting at y.",
    inputSchema: z.object({
      x: z.number().int().optional().describe("Left edge in sprite pixels. Default 0."),
      y: z.number().int().optional().describe("Top edge in sprite pixels. Default 0."),
      width: z.number().int().min(1).optional().describe("Default: to the right edge."),
      height: z.number().int().min(1).optional().describe("Default: to the bottom edge."),
      layer: z.string().optional().describe("Read only this layer. Default: all visible layers composited."),
      frame: z.number().int().min(1).optional().describe("1-based frame. Default: active frame."),
    }),
  },
  async (args) => {
    try {
      const { result } = await link.request("read_pixels", args);
      const legend = Object.entries(result.legend ?? {})
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([k, v]) => `${k}=${v}`)
        .join("  ");
      const width = String(result.y + result.rows.length - 1).length;
      const rows = (result.rows as string[]).map((r, i) => `${String(result.y + i).padStart(width)}| ${r}`);
      const header =
        `Region x=${result.x} y=${result.y} ${result.width}x${result.height}, frame ${result.frame}` +
        (result.layer ? `, layer "${result.layer}"` : "") +
        `. Keys: ${result.keys}. '.'=transparent '-'=outside canvas.`;
      return { content: [text([header, `Legend: ${legend || "(none)"}`, ...rows].join("\n"))] };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "list_commands",
  {
    title: "List Aseprite commands",
    description:
      "List Aseprite's built-in commands (menus, dialogs, filters, panels) with their parameters and accepted " +
      "values. Filter by a substring of the name or title, e.g. 'size', 'frame', 'palette', 'export'.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Case-insensitive substring of the command name or menu title."),
    }),
  },
  async ({ filter }) => {
    const f = filter?.toLowerCase();
    const matches = COMMANDS.filter(
      (c) => !f || c.name.toLowerCase().includes(f) || c.title.toLowerCase().includes(f),
    );
    const lines = matches.map((c) => {
      const params = c.params
        .filter((p) => p.name !== "ui" && !p.name.startsWith("_"))
        .map((p) => {
          let s = `${p.name}: ${p.type}`;
          if (p.values) s += ` (${p.values.join("|")})`;
          if (p.default) s += ` = ${p.default}`;
          return s;
        });
      return `${c.name} — ${c.title || "(no title)"}${params.length ? `\n    ${params.join("\n    ")}` : ""}`;
    });
    const note =
      "Parameters are read from Aseprite's source; a command may accept more. Commands with no listed parameters " +
      "act on the active sprite/layer/frame. ui=false is added automatically by run_command.";
    return { content: [text(`${matches.length} of ${COMMANDS.length} commands.\n${note}\n\n${lines.join("\n")}`)] };
  },
);

server.registerTool(
  "run_command",
  {
    title: "Run Aseprite command",
    description:
      "Run one of Aseprite's built-in commands by name (see list_commands), with parameters. Acts on the active " +
      "sprite, layer and frame. Colors may be given as '#rrggbb' strings; rectangles as {x, y, width, height}. " +
      "Pass ui: true only when the user should interact with the dialog. UI commands like Timeline, PaletteEditor, " +
      "ShowGrid or PlayAnimation work too.",
    inputSchema: z.object({
      name: z.string().describe("Command name, e.g. 'CanvasSize', 'SpriteSize', 'ChangePixelFormat'."),
      params: z.record(z.string(), z.unknown()).optional().describe("Command parameters."),
    }),
  },
  async ({ name, params }) => {
    const info = COMMANDS_BY_NAME.get(name.toLowerCase());
    if (!info) {
      const close = COMMANDS.filter((c) => c.name.toLowerCase().includes(name.toLowerCase().slice(0, 5)))
        .slice(0, 8)
        .map((c) => c.name);
      return failure(`Unknown command: ${name}.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""}`);
    }
    // Mark color-typed parameters so the extension builds Color objects.
    const colorParams = new Set(info.params.filter((p) => p.type === "color").map((p) => p.name));
    const converted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      converted[k] = colorParams.has(k) && typeof v === "string" ? { __color: v } : v;
    }
    try {
      const { result } = await link.request("run_command", { name: info.name, params: converted }, 120_000);
      if (!result.executed) return { content: [text(result.note ?? "Command did not run")], isError: true };
      return { content: [text(`${info.name} ran.`)] };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "read_guide",
  {
    title: "Read the Aseprite agent guide",
    description:
      "Read a guide topic: 'basics' (API rules that prevent bugs; read before the first edit), 'recipes' (tested " +
      "Lua snippets for common tasks), 'pixel-art' (style rules and working loop). Call with no topic to list topics.",
    inputSchema: z.object({ topic: z.string().optional() }),
  },
  async ({ topic }) => {
    const topics = guideTopics();
    if (!topic) return { content: [text(`Topics: ${topics.join(", ")}`)] };
    const key = topic.toLowerCase().replace(/\.md$/, "");
    if (!topics.includes(key)) return failure(`Unknown topic: ${topic}. Topics: ${topics.join(", ")}`);
    return { content: [text(readFileSync(`${GUIDE_DIR}${key}.md`, "utf8"))] };
  },
);

server.registerTool(
  "undo",
  {
    title: "Undo",
    description: "Undo the last steps in the active sprite. Each execute_lua call is one step.",
    inputSchema: z.object({ steps: z.number().int().min(1).max(100).optional() }),
  },
  async ({ steps }) => {
    try {
      const { result } = await link.request("undo", { steps: steps ?? 1 });
      return { content: [text(result)] };
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "redo",
  {
    title: "Redo",
    description: "Redo steps undone with undo.",
    inputSchema: z.object({ steps: z.number().int().min(1).max(100).optional() }),
  },
  async ({ steps }) => {
    try {
      const { result } = await link.request("redo", { steps: steps ?? 1 });
      return { content: [text(result)] };
    } catch (err) {
      return failure(err);
    }
  },
);

return server;
}
