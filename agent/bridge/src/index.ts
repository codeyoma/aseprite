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
import { join } from "node:path";
import { AsepriteLink, log, logToFile } from "./aseprite.js";
import { BACKGROUND, IS_WINDOWS } from "./platform.js";
import { bridgeMethods } from "./bridge_methods.js";
import { ChatRunner } from "./chat.js";
import { spawn } from "node:child_process";
import { startHttpEndpoint } from "./http.js";
import { CodexImageGenerator, ImageJobs } from "./image_gen.js";
import { SavedCommands } from "./saved_commands.js";
import { createMcpServer, VERSION } from "./server.js";
import { homeBelongsToAnother, newToken, pinnedBridge, recordBridge, sessionDir } from "./session.js";
import { toolContext } from "./tool.js";

const DAEMON_IDLE_EXIT_MS = 120_000;

async function main() {
  const daemon = process.argv.includes("--daemon");
  // Windows: Aseprite starts the daemon with `start "" /B node`, in the console window cmd opened; that window would
  // stay as long as the daemon runs. Start again in a hidden console and let this one, and the window, close.
  const hidden = process.env.ASEPRITE_AGENT_HIDDEN === "1";
  delete process.env.ASEPRITE_AGENT_HIDDEN; // not for the processes this one starts (Aseprite, after an update)
  if (daemon && IS_WINDOWS && !hidden) {
    spawn(process.execPath, process.argv.slice(1), { ...BACKGROUND, stdio: "ignore", env: { ...process.env, ASEPRITE_AGENT_HIDDEN: "1" } }).unref();
    process.exit(0);
  }
  if (daemon) logToFile(join(sessionDir, "daemon.log"));
  const link = new AsepriteLink();
  link.sessionExtra = { bridgePath: fileURLToPath(import.meta.url), version: VERSION, mode: daemon ? "daemon" : "stdio" };
  const self = fileURLToPath(import.meta.url);
  // A home pinned to another bridge (the user's stable instance) isn't ours: tools still work over stdio, but
  // Aseprite keeps its own bridge.
  const foreign = homeBelongsToAnother(self);
  if (foreign && daemon) {
    // Aseprite asked for its daemon but started this bridge (a path it remembered): start the pinned one instead.
    const pinned = pinnedBridge()!;
    log(`${sessionDir} belongs to ${pinned}; starting that bridge instead`);
    spawn(process.execPath, [pinned, "--daemon"], { ...BACKGROUND, stdio: "ignore", env: { ...process.env, ASEPRITE_AGENT_HIDDEN: "1" } }).unref();
    process.exit(0);
  }
  if (foreign) log(`${sessionDir} belongs to ${pinnedBridge()}; not publishing this bridge there (set ASEPRITE_AGENT_HOME for your own)`);
  recordBridge(self, VERSION);

  const commands = new SavedCommands();
  // spawn_agents (#33): set below, since sub-agents connect back to the endpoint.
  let subAgents: SubAgents | undefined;
  // ask needs the chat runner, made after the endpoint it uses.
  let chatRunner: ChatRunner | undefined;
  const images = new ImageJobs(new CodexImageGenerator());
  const endpoint = await startHttpEndpoint(link, newToken(), {
    commands, subAgents: () => subAgents, critic: () => subAgents, images,
    ask: (chatId, kind, title) => chatRunner?.ask(chatId, kind, title) ?? Promise.resolve(false),
    post: (chatId, ev) => chatRunner?.notify({ ...(ev as any), ...(chatId ? { chatId } : {}) }),
  });
  const chat = new ChatRunner(link, endpoint);
  chatRunner = chat;
  // Sub-agents use the running chat's agent and show their steps in the panel.
  subAgents = new SubAgents(
    endpoint,
    async () => (await link.request("state_block", {})).result.text as string,
    (chatId) => chat.currentProvider(chatId),
    (ev) => chat.notify(ev),
  );
  cleanAttachments(); // rendered attachments older than a week

  for (const [method, handler] of Object.entries(bridgeMethods(chat, VERSION, { link, commands }))) {
    link.onRequest(method, handler);
  }

  const port = await link.start(Number(process.env.ASEPRITE_AGENT_PORT ?? 0), { publish: !foreign });
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
  await createMcpServer(toolContext(link, { commands, subAgents, critic: subAgents })).connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
