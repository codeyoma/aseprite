// The Agent Provider interface: how the chat runs one agent CLI and reads
// its output. Each provider (Claude Code, Codex) is an adapter at this seam;
// ChatRunner drives any of them without knowing their flags or formats.

export type ProviderId = "claude" | "codex";

/** What a provider reports from one line of its CLI output. */
export type ProviderEvent =
  | { type: "conversation"; id: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  /** `tool` is the bridge's tool name without any MCP prefix, e.g. "execute_lua". */
  | { type: "tool"; id: string; tool: string; input: unknown }
  | { type: "tool_result"; id: string; tool: string; ok: boolean; content: unknown }
  | { type: "error"; text: string };

export interface CommandRequest {
  /** The user's message, already prefixed with the [Context] line. */
  message: string;
  /** Continue this conversation, if set. */
  conversationId?: string;
  /** The bridge's MCP endpoint the CLI must connect to. */
  mcpUrl: string;
  mcpToken: string;
  /** Extra instructions for the agent. */
  systemPrompt: string;
}

export interface AgentProvider {
  readonly id: ProviderId;
  /** Executable looked up on PATH. */
  readonly executable: string;
  /** Command-line arguments for one message. */
  command(request: CommandRequest): string[];
  /**
   * A parser for one run. It keeps whatever state the format needs (e.g.
   * matching tool results to tool calls) and turns each parsed JSON line
   * into zero or more events.
   */
  parser(): (line: any) => ProviderEvent[];
}

/** Name of the MCP server the providers configure; tool names are prefixed with it by some CLIs. */
export const MCP_SERVER_NAME = "aseprite";
