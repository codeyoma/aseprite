#!/usr/bin/env node
// aseprite-agent bridge.
//
//   node dist/index.js            MCP over stdio, for Claude Code / Codex sessions.
//   node dist/index.js --daemon   No stdio; started by Aseprite for the chat panel.
//
// Both modes connect to the Aseprite extension over WebSocket, serve MCP over
// localhost HTTP for agents spawned by the chat panel, and run the chat.

import { SubAgents } from "./subagents.js";
import { cleanAttachments } from "./attachments.js";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AsepriteLink, log } from "./aseprite.js";
import { bridgeMethods } from "./bridge_methods.js";
import { ChatRunner } from "./chat.js";
import { startHttpEndpoint } from "./http.js";
import { SavedCommands } from "./saved_commands.js";
import { createMcpServer, VERSION } from "./server.js";
import { newToken, recordBridge } from "./session.js";
import { toolContext } from "./tool.js";

const DAEMON_IDLE_EXIT_MS = 120_000;

async function main() {
  const daemon = process.argv.includes("--daemon");
  const link = new AsepriteLink();
  link.sessionExtra = { bridgePath: fileURLToPath(import.meta.url), version: VERSION, mode: daemon ? "daemon" : "stdio" };
  recordBridge(fileURLToPath(import.meta.url), VERSION);

  const commands = new SavedCommands();
  // spawn_agents (#33): set below, since sub-agents connect back to the endpoint.
  let subAgents: SubAgents | undefined;
  const endpoint = await startHttpEndpoint(link, newToken(), { commands, subAgents: () => subAgents });
  const chat = new ChatRunner(link, endpoint);
  // Sub-agents use the running chat's agent and show their steps in the panel.
  subAgents = new SubAgents(
    endpoint,
    async () => (await link.request("state_block", {})).result.text as string,
    () => chat.currentProvider(),
    (ev) => chat.notify(ev),
  );
  cleanAttachments(); // rendered attachments older than a week

  for (const [method, handler] of Object.entries(bridgeMethods(chat, VERSION, { link, commands }))) {
    link.onRequest(method, handler);
  }

  const port = await link.start(Number(process.env.ASEPRITE_AGENT_PORT ?? 0));
  log(`listening on ws://127.0.0.1:${port} (${daemon ? "daemon" : "stdio"}), MCP HTTP on ${endpoint.url}`);

  const shutdown = () => {
    chat.dispose();
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
  await createMcpServer(toolContext(link, { commands, subAgents })).connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
