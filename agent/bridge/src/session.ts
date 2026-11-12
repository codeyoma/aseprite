import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Session {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** Absolute path of the bridge entry script, so Aseprite can start a daemon. */
  bridgePath?: string;
  [key: string]: unknown;
}

/**
 * The agent's folder (bridge session, chats' workspace, attachments, commands, Codex home). ASEPRITE_AGENT_HOME
 * gives an instance its own (the dev instance uses ~/.aseprite-agent-dev), so a test bridge never takes over the
 * user's Aseprite. `--dev` without it picks the dev instance's home (tools/instances.mjs), as this repository's
 * .mcp.json does: a coding session's bridge then never claims the stable instance's home. It sets the variable, so
 * what the bridge starts agrees.
 */
if (!process.env.ASEPRITE_AGENT_HOME && process.argv.includes("--dev")) {
  process.env.ASEPRITE_AGENT_HOME = process.env.ASEPRITE_AGENT_DEV_HOME ?? join(homedir(), ".aseprite-agent-dev");
}
export const sessionDir = process.env.ASEPRITE_AGENT_HOME ?? join(homedir(), ".aseprite-agent");
export const sessionFile = join(sessionDir, "session.json");

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Where this bridge is installed, kept after it exits (unlike the session
 * file), so a Claude Code plugin in any folder can start it (#30).
 */
export const bridgeFile = join(sessionDir, "bridge.json");

/**
 * The bridge this agent home is pinned to (the stable installer writes `pinned: true` into bridge.json), or undefined.
 * Another bridge started with this home (a CLI session's MCP server, a test without its own home) must not take the
 * home over: it records nothing and publishes no session, so the instance keeps running its own bridge.
 */
export function pinnedBridge(): string | undefined {
  try {
    const info = JSON.parse(readFileSync(bridgeFile, "utf8"));
    return info?.pinned === true && typeof info.bridgePath === "string" ? info.bridgePath : undefined;
  } catch {
    return undefined;
  }
}

/** True when this home is pinned to a bridge other than `self` (paths compared after resolving links). */
export function homeBelongsToAnother(self: string, pinned = pinnedBridge()): boolean {
  if (!pinned) return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return real(pinned) !== real(self);
}

export function recordBridge(bridgePath: string, version: string): void {
  // A pinned home keeps the file as the installer wrote it, whichever bridge this is (rewriting it would drop the pin).
  if (pinnedBridge()) return;
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(bridgeFile, JSON.stringify({ bridgePath, version }, null, 2) + "\n");
  } catch {
    // Not fatal: the plugin falls back to npx.
  }
}

/** Publish the port and token so the Aseprite extension can find this bridge. */
export function writeSession(session: Session): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/** Remove the session file, but only if it still belongs to this process. */
export function removeSession(pid: number): void {
  try {
    const current = JSON.parse(readFileSync(sessionFile, "utf8")) as Session;
    if (current.pid === pid) unlinkSync(sessionFile);
  } catch {
    // Already gone or unreadable: nothing to clean up.
  }
}

/**
 * Several bridges can run at once (one per agent session). The newest one
 * owns the session file. When it exits and removes the file, re-publish
 * ours so Aseprite reconnects to a bridge that is still alive.
 */
export function keepSessionPublished(session: Session, intervalMs = 2000): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!existsSync(sessionFile)) writeSession(session);
  }, intervalMs);
  timer.unref();
  return timer;
}
