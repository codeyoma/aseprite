// Codex adapter: `codex exec --json`.
import { MCP_SERVER_NAME, type AgentProvider, type ProviderEvent } from "./agent_provider.js";
import { agentCodexHome } from "./agent_home.js";

export const codexProvider: AgentProvider = {
  id: "codex",
  executable: "codex",

  acp: {
    package: "@agentclientprotocol/codex-acp",
    bin: "codex-acp",
    sessionMeta: () => ({}),
    // CODEX_CONFIG is merged into the session config. Codex's shell runs in
    // its sandbox with its own approvals in Agent mode; Ask and Plan get a
    // read-only sandbox; Developer mode may write in the repository.
    // A private CODEX_HOME (#87): the user's model and auth, none of their
    // MCP servers, plugins, skills or notify hooks.
    env: (systemPrompt, mode) => ({
      CODEX_HOME: agentCodexHome(),
      CODEX_CONFIG: JSON.stringify({
        developer_instructions: systemPrompt,
        ...(mode === "developer" ? { sandbox_mode: "workspace-write" } : mode === "ask" || mode === "plan" ? { sandbox_mode: "read-only" } : {}),
      }),
    }),
  },

  command({ message, conversationId, mcpUrl, mcpToken, systemPrompt }) {
    const s = `mcp_servers.${MCP_SERVER_NAME}`;
    const config = [
      `${s}.url="${mcpUrl}"`,
      `${s}.http_headers={ Authorization = "Bearer ${mcpToken}" }`,
      `${s}.tool_timeout_sec=180`,
      // codex exec cannot ask the user, so pre-approve this server's tools.
      `${s}.default_tools_approval_mode="approve"`,
      `developer_instructions=${JSON.stringify(systemPrompt)}`,
    ].flatMap((c) => ["-c", c]);
    const base = ["exec", "--json", "--skip-git-repo-check", ...config];
    return conversationId ? [...base, "resume", conversationId, message] : [...base, message];
  },

  parser() {
    return (ev: any): ProviderEvent[] => {
      const item = ev?.item;
      if (ev?.type === "thread.started" && ev.thread_id) return [{ type: "conversation", id: ev.thread_id }];
      if (ev?.type === "item.started" && item?.type === "mcp_tool_call") {
        return [{ type: "tool", id: item.id, tool: String(item.tool ?? ""), input: item.arguments }];
      }
      if (ev?.type === "item.completed" && item) {
        if (item.type === "agent_message" && item.text?.trim()) return [{ type: "text", text: item.text.trim() }];
        if (item.type === "reasoning" && item.text?.trim()) return [{ type: "thinking", text: item.text.trim() }];
        if (item.type === "mcp_tool_call") {
          return [{
            type: "tool_result",
            id: item.id,
            tool: String(item.tool ?? ""),
            ok: item.status !== "failed" && !item.error,
            content: item.result ?? item.error?.message ?? "",
          }];
        }
        return [];
      }
      if (ev?.type === "error" || ev?.type === "turn.failed") {
        return [{ type: "error", text: String(ev.message ?? ev.error?.message ?? "error") }];
      }
      return [];
    };
  },
};
