// What a tool is (the Tool interface, its results, and the seam to
// Aseprite), shared by tools.ts and every *_tools.ts module. Kept apart from
// tools.ts so tool modules can import it without an import cycle.
import type * as z from "zod/v4";
import type { Reply } from "./aseprite.js";

/** The seam tools use to reach Aseprite: AsepriteLink in the bridge, a fake in tests. */
export interface AsepriteRequester {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Reply>;
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
