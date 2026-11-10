// The wire protocol between bridge and extension, read from the single
// definition the extension ships (agent/extension/protocol.json). In the
// npm package it is copied next to the guide.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What a request does to the document (the extension's operation policy):
 * a read leaves it alone; a write changes it and is captured as an edit step,
 * refused for a sub-agent's scope; a scoped-write changes cels, layers or
 * frames and is undone when a sub-agent's step changed anything outside its scope.
 */
export type RequestKind = "read" | "write" | "scoped-write";

export interface RequestSpec {
  kind: RequestKind;
  /** Needs an active sprite. Default: true for writes, false for reads. */
  needsSprite?: boolean;
  binary?: boolean;
  /** Params: name -> type ("integer", "layer?", "frames?all", ...). */
  params: Record<string, string>;
}

export interface Protocol {
  version: number;
  requests: Record<string, RequestSpec>;
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

const isList = (v: unknown) => Array.isArray(v);
const CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  array: isList,
  object: (v) => typeof v === "object" && v !== null && !isList(v),
  any: () => true,
  layer: (v) => typeof v === "string" || typeof v === "number",
  frame: (v) => Number.isInteger(v),
  frames: (v) => typeof v === "number" || typeof v === "string" || isList(v),
};

/**
 * Checks a request's params against protocol.json before sending (#53):
 * unknown or missing params and wrong types. Layer and frame references are
 * resolved by the extension, against the live sprite. Undefined values are
 * left out, as JSON drops them.
 */
export function checkParams(method: string, params: Record<string, unknown> = {}): void {
  const schema = PROTOCOL.requests[method]?.params;
  if (!schema) throw new Error(`Not a protocol request: ${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && !(k in schema) && k !== "scope") throw new Error(`${method}: unknown param '${k}'`);
  }
  for (const [name, type] of Object.entries(schema)) {
    const [, base, optional] = /^([a-z]+)(\??)/.exec(type)!;
    const v = params[name];
    if (v === undefined) {
      if (!optional) throw new Error(`${method}: '${name}' is required`);
    } else if (!CHECKS[base]?.(v)) {
      throw new Error(`${method}: '${name}' must be ${base === "frames" ? "a frame spec" : `a ${base}`}`);
    }
  }
}
