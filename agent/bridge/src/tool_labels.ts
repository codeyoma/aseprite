// How tool calls are described in the chat panel's step rows.
import { findTool } from "./tools.js";
const DETAIL_LIMIT = 600;

export function shorten(text: string): string {
  const t = text.trim();
  return t.length > DETAIL_LIMIT ? t.slice(0, DETAIL_LIMIT) + "…" : t;
}

/** "edit" for tools that change the document, "read" for the rest (from the Tool table). */
export function toolKind(tool: string): "edit" | "read" {
  return findTool(tool)?.kind ?? "read";
}

/** Short description of a tool call, e.g. "Add Shadow layer" (from the Tool table). */
export function describeTool(tool: string, input: any): string {
  return findTool(tool)?.label(input) ?? (tool || "tool");
}

/** Tool input shown when a tool row is expanded. */
export function inputDetail(input: any): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.code === "string") return shorten(input.code);
  const { label, ...rest } = input;
  return Object.keys(rest).length ? shorten(JSON.stringify(rest)) : "";
}

/** Text of a tool result (MCP content blocks, or a string). */
export function resultDetail(content: any): string {
  if (typeof content === "string") return shorten(content);
  const parts = Array.isArray(content) ? content : (content?.content ?? []);
  const texts = parts.filter((c: any) => c?.type === "text").map((c: any) => c.text);
  const images = parts.filter((c: any) => c?.type === "image").length;
  return shorten([...texts, images ? `(${images} image${images > 1 ? "s" : ""})` : ""].filter(Boolean).join("\n"));
}
