// Maps ACP session/update notifications (Agent Client Protocol) to provider
// events. Works for any ACP agent; the Claude and Codex adapters differ only
// in how they name MCP tools, which normalizeTool() handles.
import { MCP_SERVER_NAME, type ProviderEvent } from "./agent_provider.js";

/** A plan entry as the panel shows it. */
export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type AcpEvent = ProviderEvent | { type: "plan"; entries: PlanEntry[] };

interface ToolInfo {
  tool: string; // bridge tool name ("execute_lua") or the agent's own title
  input: unknown;
  kind?: "edit" | "read";
  hidden: boolean;
}

const EDIT_KINDS = new Set(["edit", "delete", "move", "execute"]);

/**
 * The bridge tool behind an ACP tool call, or the agent's own tool.
 * Claude: name/title "mcp__aseprite__execute_lua", rawInput = arguments.
 * Codex: title "mcp.aseprite.execute_lua", rawInput = { server, tool, arguments }.
 */
export function normalizeTool(update: any): ToolInfo {
  const raw = update.rawInput;
  const hidden = String(update.toolCallId ?? "").startsWith("guardian_assessment") || update.title === "Guardian Review";
  if (raw && typeof raw === "object" && raw.server === MCP_SERVER_NAME && typeof raw.tool === "string") {
    return { tool: raw.tool, input: raw.arguments ?? {}, hidden };
  }
  const name: string = update._meta?.claudeCode?.toolName ?? update.name ?? update.title ?? "";
  const m = /^(?:mcp__aseprite__|mcp\.aseprite\.)(\w+)$/.exec(name) ?? /^(?:mcp__aseprite__|mcp\.aseprite\.)(\w+)$/.exec(update.title ?? "");
  if (m) return { tool: m[1], input: raw ?? {}, hidden };
  // The agent's own tool (e.g. a shell read): keep its title and ACP kind.
  return { tool: update.title || name || "tool", input: raw ?? {}, kind: EDIT_KINDS.has(update.kind) ? "edit" : "read", hidden };
}

/** Text of a tool result: Claude rawOutput (content array) or Codex rawOutput.result. */
function toolOutput(update: any): unknown {
  const out = update.rawOutput;
  if (out && typeof out === "object" && !Array.isArray(out) && out.result) return out.result.content ?? out.result;
  if (out !== undefined && !(out && typeof out === "object" && "exit_code" in out)) return out;
  const content = (update.content ?? []).map((c: any) => c?.content).filter(Boolean);
  return content.length ? content : "";
}

function hasInput(v: unknown): boolean {
  return !!v && typeof v === "object" && Object.keys(v as object).length > 0;
}

/**
 * Stateful per prompt turn: merges message and thought chunks, refines a
 * tool step as its input streams in, and reports results.
 */
export class AcpMapper {
  private text = "";
  private textId?: string;
  private thought = "";
  private thoughtId?: string;
  private tools = new Map<string, ToolInfo>();

  /** Events for one session/update `update` object. */
  map(update: any): AcpEvent[] {
    const kind = update?.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const out = this.flushThought();
      if (this.textId !== undefined && update.messageId !== undefined && update.messageId !== this.textId) out.push(...this.flushText());
      this.textId = update.messageId;
      if (update.content?.type === "text") this.text += update.content.text ?? "";
      return out;
    }
    if (kind === "agent_thought_chunk") {
      const out = this.flushText();
      if (this.thoughtId !== undefined && update.messageId !== undefined && update.messageId !== this.thoughtId) out.push(...this.flushThought());
      this.thoughtId = update.messageId;
      if (update.content?.type === "text") this.thought += update.content.text ?? "";
      return out;
    }

    const out = [...this.flushText(), ...this.flushThought()];
    if (kind === "tool_call") {
      const info = normalizeTool(update);
      this.tools.set(update.toolCallId, info);
      if (!info.hidden) out.push(this.toolEvent(update.toolCallId, info));
      out.push(...this.result(update));
    } else if (kind === "tool_call_update") {
      const info = this.tools.get(update.toolCallId);
      if (info && !info.hidden && hasInput(update.rawInput)) {
        const refreshed = normalizeTool({ ...update, title: update.title ?? undefined, name: undefined, _meta: update._meta });
        // Keep the tool identity from the call; take the newer input.
        info.input = refreshed.tool === info.tool ? refreshed.input : update.rawInput;
        out.push(this.toolEvent(update.toolCallId, info));
      }
      out.push(...this.result(update));
    } else if (kind === "plan") {
      out.push({
        type: "plan",
        entries: (update.entries ?? []).map((e: any) => ({ content: String(e.content ?? ""), status: e.status ?? "pending" })),
      });
    }
    return out;
  }

  /** Text and thoughts still buffered at the end of a turn. */
  flush(): AcpEvent[] {
    return [...this.flushThought(), ...this.flushText()];
  }

  private toolEvent(id: string, info: ToolInfo): ProviderEvent {
    return { type: "tool", id, tool: info.tool, input: info.input, ...(info.kind ? { kind: info.kind } : {}) } as ProviderEvent;
  }

  private result(update: any): AcpEvent[] {
    const info = this.tools.get(update.toolCallId);
    if (!info || info.hidden) return [];
    if (update.status !== "completed" && update.status !== "failed") return [];
    return [{ type: "tool_result", id: update.toolCallId, tool: info.tool, ok: update.status === "completed", content: toolOutput(update) }];
  }

  private flushText(): AcpEvent[] {
    const t = this.text.trim();
    this.text = "";
    this.textId = undefined;
    return t ? [{ type: "text", text: t }] : [];
  }

  private flushThought(): AcpEvent[] {
    const t = this.thought.trim();
    this.thought = "";
    this.thoughtId = undefined;
    return t ? [{ type: "thinking", text: t }] : [];
  }
}
