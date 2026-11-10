import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

export const sessionDir = join(homedir(), ".aseprite-agent");
export const sessionFile = join(sessionDir, "session.json");

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Where this bridge is installed, kept after it exits (unlike the session
 * file), so a Claude Code plugin in any folder can start it (#30).
 */
export const bridgeFile = join(sessionDir, "bridge.json");

export function recordBridge(bridgePath: string, version: string): void {
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
