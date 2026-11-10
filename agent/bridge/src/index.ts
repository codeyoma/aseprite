#!/usr/bin/env node
// aseprite-agent bridge.
//
//   node dist/index.js            MCP over stdio, for Claude Code / Codex sessions.
//   node dist/index.js --daemon   No stdio; started by Aseprite for the chat panel.
//
// Both modes connect to the Aseprite extension over WebSocket, serve MCP over
// localhost HTTP for agents spawned by the chat panel, and run the chat.

import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AsepriteLink, log } from "./aseprite.js";
import { ChatRunner } from "./chat.js";
import { providerFor } from "./providers/index.js";
import { startHttpEndpoint } from "./http.js";
import { createMcpServer, VERSION } from "./server.js";
import { newToken } from "./session.js";

const DAEMON_IDLE_EXIT_MS = 120_000;

async function main() {
  const daemon = process.argv.includes("--daemon");
  const link = new AsepriteLink();
  link.sessionExtra = { bridgePath: fileURLToPath(import.meta.url), version: VERSION, mode: daemon ? "daemon" : "stdio" };

  const endpoint = await startHttpEndpoint(link, newToken());
  const chat = new ChatRunner(link, endpoint);

  link.onRequest("chat.info", () => ({ providers: chat.providers(), busy: chat.busy, version: VERSION }));
  link.onRequest("chat.send", (p: { prompt: string; context?: string; provider?: string; sessionId?: string }) => {
    if (!p.prompt?.trim()) throw new Error("Empty prompt");
    chat.send(p.prompt, p.context ?? "", providerFor(p.provider), p.sessionId || undefined);
    return { started: true };
  });
  link.onRequest("chat.stop", () => {
    chat.stop();
    return { stopped: true };
  });
  link.onRequest("chat.reset", () => {
    chat.reset();
    return { reset: true };
  });

  const port = await link.start(Number(process.env.ASEPRITE_AGENT_PORT ?? 0));
  log(`listening on ws://127.0.0.1:${port} (${daemon ? "daemon" : "stdio"}), MCP HTTP on ${endpoint.url}`);

  const shutdown = () => {
    chat.stop();
    link.stop();
    endpoint.server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (daemon) {
    // Exit when Aseprite has been gone for a while, unless the chat is running.
    let lastSeen = Date.now();
    setInterval(() => {
      if (link.connected || chat.busy) lastSeen = Date.now();
      else if (Date.now() - lastSeen > DAEMON_IDLE_EXIT_MS) {
        log("daemon idle, exiting");
        shutdown();
      }
    }, 5_000);
    return;
  }

  process.stdin.on("close", shutdown);
  await createMcpServer(link).connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
