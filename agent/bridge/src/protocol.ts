// The wire protocol between bridge and extension, read from the single
// definition the extension ships (agent/extension/protocol.json). In the
// npm package it is copied next to the guide.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Protocol {
  version: number;
  requests: Record<string, { binary?: boolean }>;
  bridgeMethods: string[];
  notifications: { "chat.event": { types: string[]; fields: string[] } };
}

const candidates = [
  new URL("../protocol.json", import.meta.url), // npm package
  new URL("../../extension/protocol.json", import.meta.url), // repository
].map((u) => fileURLToPath(u));

const file = candidates.find((f) => existsSync(f));
if (!file) throw new Error(`protocol.json not found (looked in ${candidates.join(", ")})`);

export const PROTOCOL: Protocol = JSON.parse(readFileSync(file, "utf8"));

export function isRequest(method: string): boolean {
  return Object.hasOwn(PROTOCOL.requests, method);
}
