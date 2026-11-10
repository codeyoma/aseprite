#!/usr/bin/env node
// aseprite-agent bridge: MCP server (stdio) <-> Aseprite extension (WebSocket).

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { AsepriteLink, log } from "./aseprite.js";
import { encodeSnapshot } from "./png.js";

const INSTRUCTIONS = `
You control a running Aseprite (pixel-art and animation editor) through these tools.

Workflow:
1. Call get_state first to see the open sprite, layers, frames, tags and palette.
2. Make changes with execute_lua. Each call is one undo step and rolls back on error.
3. Call snapshot after visual changes and check the result before continuing.

Aseprite Lua essentials:
- Globals: app, Sprite, Image, Color, Point, Rectangle, Size, Palette, ColorMode, json.
- app.sprite / app.layer / app.frame / app.cel are the active objects (may be nil).
- Frames and layer stack indices are 1-based. sprite.layers is bottom to top.
- A cel is the image of one layer in one frame: layer:cel(frame) or sprite:newCel(layer, frame, image, Point(x, y)).
- cel.image is positioned at cel.position; edit a copy and assign it back, or draw with image:drawPixel(x, y, color).
- Any menu command: app.command.CommandName{ param = value, ui = false }.
  Examples: CanvasSize, SpriteSize, ChangePixelFormat{format="indexed"}, ColorQuantization, NewFrame, NewFrameTag,
  ReverseFrames, Outline, Flip, Rotate, ExportSpriteSheet, Timeline, PaletteEditor, ShowGrid, ShowOnionSkin.
- Tools: app.tool = "pencil"; app.useTool{ tool="pencil", color=Color(255,0,0), points={Point(0,0), Point(4,4)} }.
- Frame duration is in seconds: sprite.frames[i].duration = 0.1.
- Pass ui=false to commands so no modal dialog blocks the agent.
`.trim();

const link = new AsepriteLink();

const server = new McpServer(
  { name: "aseprite-agent", version: "0.1.0" },
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

async function main() {
  const port = await link.start(Number(process.env.ASEPRITE_AGENT_PORT ?? 0));
  log(`listening on ws://127.0.0.1:${port}`);

  const shutdown = () => {
    link.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  link.stop();
  process.exit(1);
});
