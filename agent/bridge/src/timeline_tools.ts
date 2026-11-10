// Timeline as text: read the timeline as compact text, edit it, apply it in
// one undo step.
import * as z from "zod/v4";
import { failure, text, type Tool, type ToolResult } from "./tool.js";

export const TIMELINE_TOOLS: Tool[] = [
  {
    name: "get_timeline_text",
    title: "Timeline as text",
    description:
      "The active sprite's timeline as compact text: frame count, frame durations, tags (range, direction, " +
      "repeats) and linked cels. Edit the text and pass it to apply_timeline_text to change the timeline in one step.",
    input: z.object({}),
    kind: "read",
    label: () => "Read the timeline",
    async run(_input, ctx) {
      const { result } = await ctx.request("get_timeline_text", {});
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
    async run({ text: body, plan }, ctx) {
      const { result } = await ctx.request("apply_timeline_text", { text: body, plan: !!plan });
      return formatTimelineResult(result, !!plan);
    },
  },
];

/** apply_timeline_text result: errors with line numbers, or the changes. */
export function formatTimelineResult(result: any, plan: boolean): ToolResult {
  const errors = (result.errors ?? []) as string[];
  if (errors.length) return failure(`Nothing changed. Fix these lines:\n${errors.join("\n")}`);
  const changes = (result.changes ?? []) as string[];
  if (!changes.length) return { content: [text("No changes: the timeline already matches.")] };
  const head = plan ? "Planned changes (not applied):" : "Applied in one undo step:";
  return { content: [text(`${head}\n${changes.map((c) => `- ${c}`).join("\n")}`)] };
}
