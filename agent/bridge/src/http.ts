// Streamable HTTP MCP endpoint on localhost, used by agent CLIs that the
// chat panel spawns, so they share this bridge's Aseprite connection.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from "@modelcontextprotocol/node";
import type { AsepriteLink } from "./aseprite.js";
import { log } from "./aseprite.js";
import { createMcpServer } from "./server.js";

export interface HttpEndpoint {
  url: string;
  token: string;
  server: Server;
}

export async function startHttpEndpoint(link: AsepriteLink, token: string): Promise<HttpEndpoint> {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    // Stateless: one MCP server and transport per request.
    const mcp = createMcpServer(link);
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
  return { url: `http://127.0.0.1:${port}/mcp`, token, server };
}
