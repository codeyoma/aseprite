import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Session {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export const sessionDir = join(homedir(), ".aseprite-agent");
export const sessionFile = join(sessionDir, "session.json");

export function newToken(): string {
  return randomBytes(24).toString("hex");
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
