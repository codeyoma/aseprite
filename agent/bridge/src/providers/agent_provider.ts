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
  | { type: "tool"; id: string; tool: string; input: unknown; kind?: "edit" | "read" }
  | { type: "tool_result"; id: string; tool: string; ok: boolean; content: unknown }
  | { type: "error"; text: string };

export interface CommandRequest {
  /** The user's message, already prefixed with the <aseprite-state> block. */
  message: string;
  /** Continue this conversation, if set. */
  conversationId?: string;
  /** The bridge's MCP endpoint the CLI must connect to. */
  mcpUrl: string;
  mcpToken: string;
  /** Extra instructions for the agent. */
  systemPrompt: string;
}

/** How to run the provider as an ACP agent (Agent Client Protocol). */
export interface AcpSpec {
  /** npm package that provides the ACP agent, and its bin name. */
  package: string;
  bin: string;
  /** `_meta` for session/new and session/load. Developer mode keeps the agent's coding tools (#28). */
  sessionMeta(systemPrompt: string, developer?: boolean): Record<string, unknown>;
  /** Extra environment for the agent process. */
  env(systemPrompt: string, developer?: boolean): Record<string, string>;
}

export interface AgentProvider {
  readonly id: ProviderId;
  /** Preferred runtime; the stream-json command below is the fallback. */
  readonly acp?: AcpSpec;
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
