// Core tools: reading the document (state, context, pixels, snapshots,
// checks, visual diffs), running Lua, undo/redo, variations and sub-agents.
import * as z from "zod/v4";
import { encodeSnapshot } from "./png.js";
import { formatSubResults } from "./subagents.js";
import { failure, text, type Content, type Tool, type ToolResult } from "./tool.js";

const steps = z.object({ steps: z.number().int().min(1).max(100).optional() });

export const CORE_TOOLS: Tool[] = [
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
    async run({ code, label, transaction }, ctx) {
      const { result } = await ctx.request("execute_lua", { code, label, transaction }, 120_000);
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
    async run({ frame, layer, scale, background }, ctx) {
      const { result, binary } = await ctx.request("snapshot", { frame, layer });
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
    async run({ instruction, tasks, parallel }, ctx) {
      if (!ctx.subAgents) return failure("Sub-agents are not available in this bridge.");
      if (!instruction && tasks.some((t: { prompt?: string }) => !t.prompt)) {
        return failure("Give an instruction, or a prompt for every task.");
      }
      const started = Date.now();
      const full = tasks.map((t: { prompt?: string }) => ({ ...t, prompt: [instruction, t.prompt].filter(Boolean).join("\n\n") }));
      const results = await ctx.subAgents.run(full, parallel ?? 4);
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
    async run({ task }, ctx) {
      const { result } = await ctx.request("propose_variations", { task });
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
    async run({ checkpoint, save, scale }, ctx) {
      const { result, binary } = await ctx.request("diff_visual", { checkpoint, save });
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
    async run(args, ctx) {
      const { result } = await ctx.request("read_pixels", args);
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
    async run(args, ctx) {
      const { result } = await ctx.request("check", args);
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
