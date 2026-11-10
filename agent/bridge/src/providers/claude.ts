// Claude Code adapter: `claude -p --output-format stream-json`.
import { MCP_SERVER_NAME, type AgentProvider, type ProviderEvent } from "./agent_provider.js";

const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export const claudeProvider: AgentProvider = {
  id: "claude",
  executable: "claude",

  acp: {
    package: "@agentclientprotocol/claude-agent-acp",
    bin: "claude-agent-acp",
    // Append our instructions to Claude Code's prompt; no built-in tools (no
    // shell, files or web), and the Aseprite tools without asking each time.
    // Developer mode keeps Claude Code's tools; edits and commands ask the
    // user through the panel's permission requests.
    sessionMeta: (systemPrompt, developer) => ({
      systemPrompt: { append: systemPrompt },
      claudeCode: {
        options: developer
          ? { allowedTools: [`mcp__${MCP_SERVER_NAME}`] }
          : { tools: [], allowedTools: [`mcp__${MCP_SERVER_NAME}`] },
      },
    }),
    env: () => ({}),
  },

  command({ message, conversationId, mcpUrl, mcpToken, systemPrompt }) {
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } },
      },
    };
    const args = [
      "-p", message,
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      // Only the Aseprite tools: no shell, file or web tools.
      "--tools", "",
      "--allowedTools", `mcp__${MCP_SERVER_NAME}`,
      "--permission-mode", "dontAsk",
      "--append-system-prompt", systemPrompt,
    ];
    if (conversationId) args.push("--resume", conversationId);
    return args;
  },

  parser() {
    const toolNames = new Map<string, string>(); // tool_use id -> tool name
    let conversation: string | undefined;

    return (ev: any): ProviderEvent[] => {
      const out: ProviderEvent[] = [];
      if (typeof ev?.session_id === "string" && ev.session_id !== conversation) {
        conversation = ev.session_id;
        out.push({ type: "conversation", id: ev.session_id });
      }
      if (ev?.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) out.push({ type: "text", text: block.text.trim() });
          else if (block.type === "thinking" && block.thinking?.trim()) out.push({ type: "thinking", text: block.thinking.trim() });
          else if (block.type === "tool_use") {
            const tool = String(block.name ?? "").replace(TOOL_PREFIX, "");
            toolNames.set(block.id, tool);
            out.push({ type: "tool", id: block.id, tool, input: block.input });
          }
        }
      } else if (ev?.type === "user") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_result") {
            out.push({
              type: "tool_result",
              id: block.tool_use_id,
              tool: toolNames.get(block.tool_use_id) ?? "",
              ok: !block.is_error,
              content: block.content,
            });
          }
        }
      } else if (ev?.type === "result" && ev.is_error) {
        out.push({ type: "error", text: String(ev.result ?? ev.subtype ?? "error") });
      }
      return out;
    };
  },
};
