#!/usr/bin/env node
// SessionStart hook (#81): tells the agent whether Aseprite is connected, so
// it does not find out from a failed edit. It reads the port of the newest
// bridge from ~/.aseprite-agent/session.json and asks that bridge's GET
// /status (on the same port as the extension's WebSocket) within 400 ms.
// No session file, a closed port, a bridge too old for /status or a slow
// answer: no output at all. Adapted from aseprite-ai-artist's session-status
// (with-pebbly/aseprite-ai-artist, MIT).
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUDGET_MS = 400;

function sessionPort() {
  try {
    const { port } = JSON.parse(readFileSync(join(homedir(), ".aseprite-agent", "session.json"), "utf8"));
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** The bridge's /status JSON, or undefined. Never takes longer than the budget. */
function status(port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      resolve(undefined);
    }, BUDGET_MS);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const req = request({ host: "127.0.0.1", port, path: "/status", method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          done(res.statusCode === 200 ? JSON.parse(body) : undefined);
        } catch {
          done(undefined);
        }
      });
      res.on("error", () => done(undefined));
    });
    req.on("error", () => done(undefined));
    req.end();
  });
}

function message(s) {
  if (!s || typeof s.connected !== "boolean") return undefined;
  return s.connected
    ? `Aseprite${s.aseprite ? ` ${s.aseprite}` : ""} is connected to the aseprite MCP bridge; its tools act on the open document.`
    : "The aseprite MCP bridge is running but Aseprite is not connected: edits will fail until the user opens Aseprite " +
        "with the Aseprite Agent extension (it connects on its own within a few seconds).";
}

const port = sessionPort();
const text = port ? message(await status(port)) : undefined;
if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
