// Command tools: Aseprite's built-in commands (list_commands, run_command)
// and Saved Commands (#26), which use the context's SavedCommands store.
import * as z from "zod/v4";
import { describeCommand, filterCommands, findCommand, COMMANDS, suggestCommands, toWireParams } from "./commands.js";
import { formatExecute } from "./core_tools.js";
import { COMMAND_NAME, type SavedCommand } from "./saved_commands.js";
import { failure, text, type Tool, type ToolContext } from "./tool.js";

export const COMMAND_TOOLS: Tool[] = [
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
    async run({ name, params }, ctx) {
      const info = findCommand(name);
      if (!info) {
        const close = suggestCommands(name);
        return failure(`Unknown command: ${name}.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""}`);
      }
      const { result } = await ctx.request(
        "run_command",
        { name: info.name, params: toWireParams(info, params) },
        120_000,
      );
      if (!result.executed) return failure(result.note ?? "Command did not run");
      return { content: [text(`${info.name} ran.`)] };
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
    async run(input, ctx) {
      const { result } = await ctx.request("compile_lua", { code: input.code });
      if (!result.ok) return failure(`The code does not compile, so it was not saved:\n${result.error}\nFix it and save again.`);
      const cmd = ctx.commands.save(input);
      await commandsChanged(ctx);
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
    async run(_input, ctx) {
      const list = ctx.commands.list();
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
    async run({ name, args }, ctx) {
      const store = ctx.commands;
      const cmd = store.get(name);
      if (!cmd) return failure(`No saved command named ${name}. Saved: ${store.list().map((c) => c.name).join(", ") || "none"}`);
      const { result } = await ctx.request("execute_lua", { code: store.code(name), label: cmd.title, args: withDefaults(cmd, args) }, 120_000);
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
    async run({ name }, ctx) {
      if (!ctx.commands.delete(name)) return failure(`No saved command named ${name}`);
      await commandsChanged(ctx);
      return { content: [text(`Deleted /${name}.`)] };
    },
  },
];

/** Tells the extension to reload its My Commands menu from the store's folder. */
async function commandsChanged(ctx: ToolContext): Promise<void> {
  await ctx.request("commands_changed", { dir: ctx.commands.dir }).catch(() => undefined);
}

/** A saved command's arguments: the given ones over the declared defaults. */
export function withDefaults(cmd: SavedCommand, args: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of cmd.params) if (p.default !== undefined) out[p.name] = p.default;
  return { ...out, ...args };
}
