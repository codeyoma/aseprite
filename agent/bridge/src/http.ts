// Streamable HTTP MCP endpoint on localhost, used by agent CLIs that the
// chat panel spawns, so they share this bridge's Aseprite connection.
import { scopeFor } from "./subagents.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import type { SavedCommands } from "./saved_commands.js";
import type { ImageJobs } from "./image_gen.js";
import { toolContext, type AsepriteRequester, type SubAgentRunner, type CriticRunner } from "./tool.js";
import { log } from "./aseprite.js";
import { createMcpServer } from "./server.js";

export interface HttpEndpoint {
  url: string;
  /** Read-only endpoint for Ask and Plan modes. */
  askUrl: string;
  /** Read-only endpoint for critics (#76): no critique, ab_compare or spawn_agents. */
  criticUrl: string;
  token: string;
  server: Server;
}

export interface HttpEndpointOptions {
  /** The Saved Commands store; default: the user's folder. */
  commands?: SavedCommands;
  /** spawn_agents' runner for the lead agent's endpoints. A getter, since SubAgents needs this endpoint's URL. */
  subAgents?: () => SubAgentRunner | undefined;
  /** critique's and ab_compare's critics (#76), for the lead agent's endpoints. */
  critic?: () => CriticRunner | undefined;
  /** Asks a chat's user a yes/no question (#102), for the lead agent's tools. */
  ask?: (chat: string, kind: string, title: string) => Promise<boolean>;
  /** Image generation jobs (#102), for the lead agent's tools. */
  images?: ImageJobs;
  /** Shows an event in a chat's log (ask_user), for the lead agent's tools. */
  post?: (chat: string, ev: { type: string; text?: string; choices?: string[]; topic?: string }) => void;
}

/** A chat turn's request may wait for the user to come back to its sprite's tab. */
export const CHAT_REQUEST_TIMEOUT_MS = 5 * 60_000;

export async function startHttpEndpoint(link: AsepriteRequester, token: string, opts: HttpEndpointOptions = {}): Promise<HttpEndpoint> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    // /mcp serves every tool; /mcp/ask only the read tools (Ask and Plan
    // modes); /mcp/scope/<id> a sub-agent's tools, with its scope on every
    // request (#33); /mcp/critic the read tools for a critic, without the
    // tools that start more agents (#76).
    const path = (req.url ?? "").split("?")[0];
    const scopeId = /^\/mcp\/scope\/([0-9a-f]+)$/.exec(path)?.[1];
    const scope = scopeId ? scopeFor(scopeId) : undefined;
    const critic = path === "/mcp/critic";
    if (path !== "/mcp" && path !== "/mcp/ask" && !critic && !scope) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    // Stateless: one MCP server and transport per request.
    // Every request here comes from a chat turn (the agent, its sub-agents
    // and critics), so it is marked with its origin and chat.
    // ?chat=<id>: the panel's chat whose agent (or sub-agent, or critic)
    // calls; the extension runs the request on that chat's sprite.
    const chat = new URL(req.url ?? "/", "http://localhost").searchParams.get("chat") ?? undefined;
    const requester: AsepriteRequester = {
      request: (method, params = {}, timeoutMs) =>
        link.request(method, scope ? { ...params, scope } : params, Math.max(timeoutMs ?? 0, CHAT_REQUEST_TIMEOUT_MS), { origin: "chat", chat }),
    };
    const lead = !scope && !critic;
    const bind = <T>(r: T | undefined): T | undefined =>
      r && chat && typeof (r as { forChat?: unknown }).forChat === "function" ? ((r as any).forChat(chat) as T) : r;
    const ctx = toolContext(requester, {
      commands: opts.commands, subAgents: lead ? bind(opts.subAgents?.()) : undefined, critic: lead ? bind(opts.critic?.()) : undefined,
      ask: lead && opts.ask ? (kind, title) => opts.ask!(chat ?? "", kind, title) : undefined,
      images: lead ? opts.images : undefined,
      post: lead && opts.post ? (ev) => opts.post!(chat ?? "", ev) : undefined,
    });
    const mcp = createMcpServer(ctx, { readOnly: path === "/mcp/ask" || critic, subAgent: !!scope, critic });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log(`HTTP MCP error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, askUrl: `http://127.0.0.1:${port}/mcp/ask`, criticUrl: `http://127.0.0.1:${port}/mcp/critic`, token, server };
}
