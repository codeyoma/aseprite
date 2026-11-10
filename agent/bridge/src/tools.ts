// The Tool table: every MCP tool the bridge offers, defined once. MCP
// registration, the chat panel's step labels and the edit/read kind all
// come from here. A tool without `run` forwards its input to the Aseprite
// request method of the same name and returns the result as JSON.
import { UI_TOOLS } from "./ui_tools.js";
import { EXPORT_TOOLS } from "./export_tools.js";
import { NORMAL_TOOLS } from "./normal_tools.js";
import { DITHER_TOOLS } from "./dither_tools.js";
import { TILE_TOOLS } from "./tile_tools.js";
import { DIRECTION_TOOLS } from "./direction_tools.js";
import { ANIMATION_TOOLS } from "./animation_tools.js";
import { SHADING_TOOLS } from "./shading_tools.js";
import { RECREATE_TOOLS } from "./recreate_tools.js";
import { SHEET_TOOLS } from "./sheet_tools.js";
import { PIXEL_TOOLS } from "./pixel_tools.js";
import { COLOR_TOOLS } from "./color_tools.js";
import { formatSubResults, type SubAgents } from "./subagents.js";
import { COMMAND_NAME, commandsDir, SavedCommands, type SavedCommand } from "./saved_commands.js";
import * as z from "zod/v4";
import type { Reply } from "./aseprite.js";
import { describeCommand, filterCommands, findCommand, COMMANDS, suggestCommands, toWireParams } from "./commands.js";
import { catalog, guideIndex, guideTopics, readGuide, searchCatalog } from "./guide.js";
import { encodeSnapshot } from "./png.js";

/** The seam tools use to reach Aseprite: AsepriteLink in the bridge, a fake in tests. */
export interface AsepriteRequester {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Reply>;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
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
  run?(input: any, aseprite: AsepriteRequester): Promise<ToolResult>;
  /** Timeout for forwarded requests. */
  timeoutMs?: number;
}

export function text(value: unknown): Content {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

export function failure(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}

const steps = z.object({ steps: z.number().int().min(1).max(100).optional() });

export const TOOLS: Tool[] = [
  {
    name: "get_state",
    title: "Get Aseprite state",
    description:
      "Return the open sprites and, for the active sprite: size, color mode, layer tree (top layer first), " +
      "frames with durations, tags, palette, selection, active layer/frame, current tool and colors.",
    input: z.object({}),
    kind: "read",
    label: () => "Read sprite state",
  },
  {
    name: "get_context",
    title: "Get user context",
    description:
      "Return what the user is working on: active layer (with group path), frame, tag and cel bounds; the timeline " +
      "range (selected layers/frames/cels); the pixel selection; the current tool, brush, colors and zoom. " +
      "Use it to resolve requests like 'this layer', 'the selected frames' or 'the selected area'.",
    input: z.object({}),
    kind: "read",
    label: () => "Read selection",
  },
  {
    name: "execute_lua",
    title: "Run Lua in Aseprite",
    description:
      "Run Lua code inside Aseprite using its scripting API. By default the code runs in one transaction: " +
      "one undo step, rolled back entirely if it raises an error. `print` output is captured, and the " +
      "chunk's return value is returned as JSON. Use this for any edit: layers, frames, cels, pixels, tags, " +
      "palette, commands (app.command.X{...}), tools (app.useTool), selection and file operations.",
    input: z.object({
      code: z.string().describe("Lua source. Use `return` to send a value back."),
      label: z.string().optional().describe("Short description of the step, e.g. 'Add Shadow layer'. Also the undo label."),
      transaction: z
        .boolean()
        .optional()
        .describe("Default true. Set false for code that must not run in a transaction, e.g. app.open, app.undo."),
    }),
    kind: "edit",
    label: (i) => (i?.label ? String(i.label) : "Run Lua"),
    async run({ code, label, transaction }, aseprite) {
      const { result } = await aseprite.request("execute_lua", { code, label, transaction }, 120_000);
      return formatExecute(result);
    },
  },
  {
    name: "snapshot",
    title: "Snapshot sprite",
    description:
      "Render the active sprite (or one layer) at a frame and return it as a PNG, upscaled with nearest-neighbor " +
      "so individual pixels are visible. Use it to check visual results after edits.",
    input: z.object({
      frame: z.number().int().min(1).optional().describe("1-based frame number. Default: active frame."),
      layer: z.string().optional().describe("Render only this layer (by name). Default: all visible layers."),
      scale: z.number().int().min(1).max(32).optional()
        .describe("Upscale factor. Default: largest factor that keeps the image at or under 512 px."),
      background: z.string().optional().describe("'checker' (default), 'transparent', or a hex color like '#202020'."),
    }),
    kind: "read",
    label: () => "Look at the sprite",
    async run({ frame, layer, scale, background }, aseprite) {
      const { result, binary } = await aseprite.request("snapshot", { frame, layer });
      if (!binary) return failure("Aseprite sent no pixel data");
      const w = result.width as number;
      const h = result.height as number;
      const s = scale ?? Math.max(1, Math.floor(512 / Math.max(w, h)));
      const png = encodeSnapshot(binary, w, h, s, background ?? "checker");
      return {
        content: [
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          text(`${w}x${h} px, frame ${result.frame}${result.layer ? `, layer "${result.layer}"` : ""}, shown at ${s}x`),
        ],
      };
    },
  },
  {
    name: "save_command",
    title: "Save as command",
    description:
      "Save Lua code as a command the user can run from File > Scripts > AI Agent > My Commands or by typing " +
      "/<name> in the chat, without an agent. Save code that already worked in execute_lua. The code runs as one " +
      "undo step on the active sprite; it gets `args`, a table of the user's arguments (from params, with defaults), " +
      "and `layerById`. Saving an existing name updates it; every save is a version that can be reverted.",
    input: z.object({
      name: z.string().regex(COMMAND_NAME).describe("Lowercase with dashes, e.g. 'outline-dark'. Also the /name in the chat."),
      title: z.string().min(1).describe("Menu title, e.g. 'Outline in Darkest Color'."),
      description: z.string().min(1).describe("One sentence on what it does; also the version's commit message."),
      code: z.string().min(1).describe("Lua body. Read arguments from args, e.g. local width = args.width or 1."),
      params: z.array(z.object({ name: z.string(), description: z.string().optional(), default: z.any().optional() }))
        .optional().describe("Arguments the command accepts. In the chat: /name key=value ..."),
    }),
    kind: "edit",
    label: (a) => (a.name ? `Save command ${a.name}` : "Save command"),
    async run(input, aseprite) {
      const { result } = await aseprite.request("compile_lua", { code: input.code });
      if (!result.ok) return failure(`The code does not compile, so it was not saved:\n${result.error}\nFix it and save again.`);
      const cmd = savedCommands().save(input);
      await aseprite.request("commands_changed", { dir: commandsDir() }).catch(() => undefined);
      return { content: [text(`Saved "${cmd.title}" as /${cmd.name}. It is in File > Scripts > AI Agent > My Commands.`)] };
    },
  },
  {
    name: "list_saved_commands",
    title: "List saved commands",
    description: "List the commands saved with save_command: name, title, description, parameters and whether it is enabled.",
    input: z.object({}),
    kind: "read",
    label: () => "List saved commands",
    async run() {
      const list = savedCommands().list();
      if (!list.length) return { content: [text("No saved commands yet.")] };
      return {
        content: [text(list.map((c) =>
          `- /${c.name}${c.enabled ? "" : " (disabled)"}: ${c.title}. ${c.description}` +
          (c.params.length ? ` Params: ${c.params.map((p) => p.name + (p.default !== undefined ? `=${JSON.stringify(p.default)}` : "")).join(", ")}` : "")).join("\n"))],
      };
    },
  },
  {
    name: "run_saved_command",
    title: "Run a saved command",
    description: "Run a saved command on the active sprite as one undo step, with optional arguments.",
    input: z.object({
      name: z.string().describe("The command's name."),
      args: z.record(z.string(), z.any()).optional().describe("Arguments, e.g. { width: 2 }."),
    }),
    kind: "edit",
    label: (a) => (a.name ? `Run /${a.name}` : "Run saved command"),
    async run({ name, args }, aseprite) {
      const store = savedCommands();
      const cmd = store.get(name);
      if (!cmd) return failure(`No saved command named ${name}. Saved: ${store.list().map((c) => c.name).join(", ") || "none"}`);
      const { result } = await aseprite.request("execute_lua", { code: store.code(name), label: cmd.title, args: withDefaults(cmd, args) }, 120_000);
      return formatExecute(result);
    },
  },
  {
    name: "delete_saved_command",
    title: "Delete a saved command",
    description: "Delete a saved command (its history stays in the commands folder's git log).",
    input: z.object({ name: z.string() }),
    kind: "edit",
    label: (a) => (a.name ? `Delete /${a.name}` : "Delete saved command"),
    async run({ name }, aseprite) {
      if (!savedCommands().delete(name)) return failure(`No saved command named ${name}`);
      await aseprite.request("commands_changed", { dir: commandsDir() }).catch(() => undefined);
      return { content: [text(`Deleted /${name}.`)] };
    },
  },
  {
    name: "get_timeline_text",
    title: "Timeline as text",
    description:
      "The active sprite's timeline as compact text: frame count, frame durations, tags (range, direction, " +
      "repeats) and linked cels. Edit the text and pass it to apply_timeline_text to change the timeline in one step.",
    input: z.object({}),
    kind: "read",
    label: () => "Read the timeline",
    async run(_input, aseprite) {
      const { result } = await aseprite.request("get_timeline_text", {});
      return { content: [text(result.text as string)] };
    },
  },
  {
    name: "apply_timeline_text",
    title: "Apply timeline text",
    description:
      "Change the timeline to match the text, in one undo step. Lines: `frames N` (add copies of the last frame or " +
      "remove frames from the end), `fps N`, `frame A-B duration 80ms`, `tag NAME A-B [forward|reverse|ping-pong|" +
      "ping-pong-reverse] [repeat=N]`, `layer NAME link A-B` / `unlink A-B`. Tags not listed are removed, so start " +
      "from get_timeline_text. Set plan: true to see the changes without applying them.",
    input: z.object({
      text: z.string().describe("The timeline text."),
      plan: z.boolean().optional().describe("Only list the changes; don't apply them."),
    }),
    kind: "edit",
    label: (a) => (a.plan ? "Plan timeline changes" : "Apply timeline changes"),
    async run({ text: body, plan }, aseprite) {
      const { result } = await aseprite.request("apply_timeline_text", { text: body, plan: !!plan });
      return formatTimelineResult(result, !!plan);
    },
  },
  {
    name: "spawn_agents",
    title: "Run sub-agents in parallel",
    description:
      "Split a multi-frame job into sub-tasks and run them in parallel, one sub-agent each (up to 4 at once). " +
      "Write the shared instruction once in `instruction` (sub-agents don't see this conversation) and give each " +
      "task its frames, plus a short `prompt` only for what differs. Sub-agents get the document state and can only " +
      "edit their scope; edits outside it are refused. Use it for jobs like shading or redrawing many frames; do " +
      "setup that touches everything (new layers, palette, frame count) yourself first. Returns each sub-agent's summary.",
    input: z.object({
      instruction: z.string().optional().describe("What every sub-agent should do, self-contained."),
      tasks: z.array(z.object({
        prompt: z.string().optional().describe("What differs for this sub-task (or the whole task if there is no instruction)."),
        frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).describe("Its frames: 3, [1,2] or '1-2'."),
        layers: z.array(z.string()).optional().describe("Only these layers (ids like 'L3' or names). Default: all layers."),
        label: z.string().optional().describe("Short name shown in the panel, e.g. 'frames 1-2'."),
      })).min(1).max(16),
      parallel: z.number().int().min(1).max(4).optional().describe("How many run at once. Default 4."),
    }),
    kind: "edit",
    label: (a) => (a.tasks ? `Run ${a.tasks.length} sub-agents` : "Run sub-agents"),
    async run({ instruction, tasks, parallel }) {
      if (!spawner) return failure("Sub-agents are not available in this bridge.");
      if (!instruction && tasks.some((t: { prompt?: string }) => !t.prompt)) {
        return failure("Give an instruction, or a prompt for every task.");
      }
      const started = Date.now();
      const full = tasks.map((t: { prompt?: string }) => ({ ...t, prompt: [instruction, t.prompt].filter(Boolean).join("\n\n") }));
      const results = await spawner.run(full, parallel ?? 4);
      const res = { content: [text(formatSubResults(results, Math.round((Date.now() - started) / 1000)))] };
      return results.every((r) => !r.ok) ? { ...res, isError: true } : res;
    },
  },
  {
    name: "propose_variations",
    title: "Show variations",
    description:
      "Show the user the variations you built for a task so they can keep one. Build each candidate first in " +
      "execute_lua with variationLayer(task, i) (i = 1..n), which returns a layer \"AI: <task> v<i>\" in a group " +
      "\"AI variations: <task>\". The panel shows thumbnails; the user keeps one or discards them all. Don't pick for them.",
    input: z.object({ task: z.string().min(1).describe("The task name you passed to variationLayer.") }),
    kind: "read",
    label: (a) => (a.task ? `Show variations of ${a.task}` : "Show variations"),
    async run({ task }, aseprite) {
      const { result } = await aseprite.request("propose_variations", { task });
      const how = result.shown
        ? "The user sees them in the chat panel and will keep one or discard them."
        : "The chat panel is not open, so the user picks one by hand: keep one layer, delete the group.";
      return { content: [text(`Showing ${result.count} variations of "${task}": ${(result.layers as string[]).join(", ")}. ${how}`)] };
    },
  },
  {
    name: "diff_visual",
    title: "Visual diff",
    description:
      "Show what changed on the active frame: compares the canvas now with the canvas before the last edit step " +
      "(default) or with a checkpoint you saved earlier (save: 'name', then checkpoint: 'name'). Returns a PNG " +
      "with changed pixels in red over a faded copy of the frame, the changed bounds and the changed-pixel count.",
    input: z.object({
      checkpoint: z.string().optional().describe("Compare with this saved checkpoint instead of the last edit step."),
      save: z.string().optional().describe("Save the current canvas as a checkpoint with this name, and return."),
      scale: z.number().int().min(1).max(32).optional()
        .describe("Upscale factor. Default: largest factor that keeps the image at or under 512 px."),
    }),
    kind: "read",
    label: (a) => (a.save ? `Save checkpoint ${a.save}` : "Compare with before"),
    async run({ checkpoint, save, scale }, aseprite) {
      const { result, binary } = await aseprite.request("diff_visual", { checkpoint, save });
      if (save) return { content: [text(`Saved checkpoint "${save}".`)] };
      return formatDiff(result, binary, scale);
    },
  },
  {
    name: "read_pixels",
    title: "Read pixels",
    description:
      "Read a region of the sprite (or one layer) as a text grid, at most 16384 pixels per call. In indexed sprites " +
      "each pixel is its palette index; in RGB sprites each color gets a short key. A legend maps keys to hex. " +
      "'.' is transparent and '-' is outside the canvas. Rows run top to bottom starting at y.",
    input: z.object({
      x: z.number().int().optional().describe("Left edge in sprite pixels. Default 0."),
      y: z.number().int().optional().describe("Top edge in sprite pixels. Default 0."),
      width: z.number().int().min(1).optional().describe("Default: to the right edge."),
      height: z.number().int().min(1).optional().describe("Default: to the bottom edge."),
      layer: z.string().optional().describe("Read only this layer. Default: all visible layers composited."),
      frame: z.number().int().min(1).optional().describe("1-based frame. Default: active frame."),
    }),
    kind: "read",
    label: () => "Inspect pixels",
    async run(args, aseprite) {
      const { result } = await aseprite.request("read_pixels", args);
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
    },
  },
  {
    name: "list_commands",
    title: "List Aseprite commands",
    description:
      "List Aseprite's built-in commands (menus, dialogs, filters, panels) with their parameters and accepted " +
      "values. Filter by a substring of the name or title, e.g. 'size', 'frame', 'palette', 'export'.",
    input: z.object({
      filter: z.string().optional().describe("Case-insensitive substring of the command name or menu title."),
    }),
    kind: "read",
    label: () => "Look up commands",
    async run({ filter }) {
      const matches = filterCommands(filter);
      const note =
        "Parameters are read from Aseprite's source; a command may accept more. Commands with no listed parameters " +
        "act on the active sprite/layer/frame. ui=false is added automatically by run_command.";
      return {
        content: [text(`${matches.length} of ${COMMANDS.length} commands.\n${note}\n\n${matches.map(describeCommand).join("\n")}`)],
      };
    },
  },
  {
    name: "run_command",
    title: "Run Aseprite command",
    description:
      "Run one of Aseprite's built-in commands by name (see list_commands), with parameters. Acts on the active " +
      "sprite, layer and frame. Colors may be given as '#rrggbb' strings; rectangles as {x, y, width, height}. " +
      "Pass ui: true only when the user should interact with the dialog. UI commands like Timeline, PaletteEditor, " +
      "ShowGrid or PlayAnimation work too.",
    input: z.object({
      name: z.string().describe("Command name, e.g. 'CanvasSize', 'SpriteSize', 'ChangePixelFormat'."),
      params: z.record(z.string(), z.unknown()).optional().describe("Command parameters."),
    }),
    kind: "edit",
    label: (i) => `Run ${i?.name ?? "command"}`,
    async run({ name, params }, aseprite) {
      const info = findCommand(name);
      if (!info) {
        const close = suggestCommands(name);
        return failure(`Unknown command: ${name}.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""}`);
      }
      const { result } = await aseprite.request(
        "run_command",
        { name: info.name, params: toWireParams(info, params) },
        120_000,
      );
      if (!result.executed) return failure(result.note ?? "Command did not run");
      return { content: [text(`${info.name} ran.`)] };
    },
  },
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
  {
    name: "check",
    title: "Check pixel art",
    description:
      "Run mechanical pixel-art checks on the active sprite and return findings with coordinates and a concrete fix: " +
      "off-palette colors (RGB sprites), orphan pixels, semi-transparent pixels, empty cels inside a tag, frame " +
      "durations that stand out within a tag, content outside the canvas, repeated frames in a tag, and feet that " +
      "jitter by 1-3 px within a tag. Run it before saying a drawing or " +
      "animation task is done; fix errors, and mention warnings you leave on purpose.",
    input: z.object({
      layer: z.string().optional().describe("Check only this layer (id like 'L12' or name). Default: all visible layers."),
      frames: z.union([z.string(), z.number().int(), z.array(z.number().int())]).optional()
        .describe("Frames to check: 3, [1,2] or '1-4'. Default: all frames."),
      rules: z.array(z.enum(["off-palette", "orphan", "semi-transparent", "empty-cel", "frame-duration", "outside-canvas",
        "duplicate-frame", "ground-jitter"]))
        .optional().describe("Rules to run. Default: all."),
    }),
    kind: "read",
    label: () => "Check pixel art",
    async run(args, aseprite) {
      const { result } = await aseprite.request("check", args);
      return { content: [text(formatCheck(result))] };
    },
  },
  {
    name: "undo",
    title: "Undo",
    description: "Undo the last steps in the active sprite. Each execute_lua call is one step.",
    input: steps,
    kind: "edit",
    label: () => "Undo",
  },
  {
    name: "redo",
    title: "Redo",
    description: "Redo steps undone with undo.",
    input: steps,
    kind: "edit",
    label: () => "Redo",
  },
];
// Palette and tone tools (#36, #38).
TOOLS.push(...COLOR_TOOLS);
// Pixel snap tools (#37).
TOOLS.push(...PIXEL_TOOLS);
// Sprite sheet import (#41).
TOOLS.push(...SHEET_TOOLS);
// Recreate from a reference (#40).
TOOLS.push(...RECREATE_TOOLS);
// Ramps, shading and outlines (#39).
TOOLS.push(...SHADING_TOOLS);
// Animation helpers (#42).
TOOLS.push(...ANIMATION_TOOLS);
// Directions (#43).
TOOLS.push(...DIRECTION_TOOLS);
// Tilesets and autotiles (#46).
TOOLS.push(...TILE_TOOLS);
// Dithering and palette swaps (#48).
TOOLS.push(...DITHER_TOOLS);
// Normal maps and 2D lighting (#47).
TOOLS.push(...NORMAL_TOOLS);
// Export for game engines (#49).
TOOLS.push(...EXPORT_TOOLS);
// Pixel text and UI elements (#50).
TOOLS.push(...UI_TOOLS);

// The bridge's sub-agent runner (#33), set by index.ts.
let spawner: SubAgents | undefined;
export function setAgentSpawner(s: SubAgents | undefined): void {
  spawner = s;
}

function savedCommands(): SavedCommands {
  return new SavedCommands();
}

/** A saved command's arguments: the given ones over the declared defaults. */
export function withDefaults(cmd: SavedCommand, args: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of cmd.params) if (p.default !== undefined) out[p.name] = p.default;
  return { ...out, ...args };
}

/** apply_timeline_text result: errors with line numbers, or the changes. */
export function formatTimelineResult(result: any, plan: boolean): ToolResult {
  const errors = (result.errors ?? []) as string[];
  if (errors.length) return failure(`Nothing changed. Fix these lines:\n${errors.join("\n")}`);
  const changes = (result.changes ?? []) as string[];
  if (!changes.length) return { content: [text("No changes: the timeline already matches.")] };
  const head = plan ? "Planned changes (not applied):" : "Applied in one undo step:";
  return { content: [text(`${head}\n${changes.map((c) => `- ${c}`).join("\n")}`)] };
}

/** An execute_lua result: output, value or error. */
export function formatExecute(result: any): ToolResult {
  const content: Content[] = [];
  if (result.output?.length) content.push(text("Output:\n" + result.output.join("\n")));
  if (result.ok) {
    content.push(text(result.value === undefined ? "OK (no return value)" : { value: result.value }));
    return { content };
  }
  content.push(text((result.rolledBack ? "Error (changes rolled back):\n" : "Error:\n") + result.error));
  return { content, isError: true };
}

/** diff_visual result: the diff PNG and a summary line. */
export function formatDiff(result: any, binary: Buffer | undefined, scale?: number): ToolResult {
  const w = result.width as number;
  const h = result.height as number;
  const b = result.bounds as { x: number; y: number; width: number; height: number } | undefined;
  const summary =
    result.changed === 0
      ? `No pixels changed (compared with ${result.against}).`
      : `${result.changed} pixels changed${result.sizeChanged ? " (canvas size changed)" : ""}, ` +
        `bounds x=${b?.x} y=${b?.y} w=${b?.width} h=${b?.height}, compared with ${result.against}. Red marks changed pixels.`;
  if (!binary || result.changed === 0) return { content: [text(summary)] };
  const s = scale ?? Math.max(1, Math.floor(512 / Math.max(w, h)));
  const png = encodeSnapshot(binary, w, h, s, "checker");
  return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, text(summary)] };
}

/** Readable check report: a summary line, then one line per finding. */
export function formatCheck(result: any): string {
  const findings: any[] = result?.findings ?? [];
  const head = `Check: ${result?.errors ?? 0} errors, ${result?.warnings ?? 0} warnings` +
    ` (${result?.checked?.layers ?? "?"} layers, ${result?.checked?.frames ?? "?"} frames)`;
  if (!findings.length) return `${head}. No problems found.`;
  const lines = findings.map((f) => {
    const where = [f.layerId && f.layer ? `${f.layerId} ${f.layer}` : f.layer, f.frame ? `frame ${f.frame}` : "",
      f.tag ? `tag ${f.tag}` : "", f.frames ? `frames ${f.frames.join(",")}` : ""].filter(Boolean).join(", ");
    const what = [f.color, f.count ? `${f.count} px` : "",
      f.pixels?.length ? `at ${f.pixels.map((p: number[]) => `(${p[0]},${p[1]})`).join(" ")}${f.count > f.pixels.length ? " …" : ""}` : ""]
      .filter(Boolean).join(" ");
    return `- ${f.severity} ${f.rule}${where ? ` [${where}]` : ""}${what ? `: ${what}` : ""}\n  fix: ${f.fix}`;
  });
  return [head, ...lines].join("\n");
}

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/** Runs a tool and turns any failure into an MCP error result. */
export async function runTool(tool: Tool, input: any, aseprite: AsepriteRequester): Promise<ToolResult> {
  try {
    if (tool.run) return await tool.run(input ?? {}, aseprite);
    const { result } = await aseprite.request(tool.name, input ?? {}, tool.timeoutMs);
    return { content: [text(result)] };
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}
