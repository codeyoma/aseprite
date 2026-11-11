// The wire protocol between bridge and extension, read from the single
// definition the extension ships (agent/extension/protocol.json). In the
// npm package it is copied next to the guide.
//
// Each side checks what it receives, once (#96): the extension checks a
// request's params (wire_params.lua, which also resolves layer and frame
// references), the bridge checks the params of the bridge methods the
// extension calls (checkBridgeParams) and the results protocol.json types
// (checkResult, get_state's State). Tool inputs are checked by zod before
// any of this. The types below are the same in wire_params.lua.
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
  /** Params: name -> type ("integer", "layer?", "frames?all", "Attachment[]?", ...). */
  params: Record<string, string>;
  /** The result's type (a shape name), checked by the bridge when the result arrives. */
  result?: string;
}

/** A method the extension calls on the bridge; the bridge checks its params on arrival (#96). */
export interface BridgeMethodSpec {
  params: Record<string, string>;
}

export interface Protocol {
  version: number;
  requests: Record<string, RequestSpec>;
  bridgeMethods: Record<string, BridgeMethodSpec>;
  /** Named object types (field -> type); "...": "Other" includes Other's fields. */
  shapes: Record<string, Record<string, string>>;
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

export function isBridgeMethod(method: string): boolean {
  return Object.hasOwn(PROTOCOL.bridgeMethods, method);
}

const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !isList(v) && !(v instanceof Uint8Array);
// Lua's json.encode writes an empty table as [], so [] stands for an empty object too, and {} for an empty list.
const isEmptyList = (v: unknown) => isList(v) && v.length === 0;
const isEmptyObject = (v: unknown) => isObject(v) && Object.keys(v).length === 0;
const CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => isList(v) || isEmptyObject(v),
  object: (v) => isObject(v) || isEmptyList(v),
  any: () => true,
  layer: (v) => typeof v === "string" || typeof v === "number",
  frame: (v) => Number.isInteger(v),
  frames: (v) => typeof v === "number" || typeof v === "string" || isList(v),
  // Pixel bytes (#95): raw bytes, which the transport sends as it can, or base64 text.
  bytes: (v) => typeof v === "string" || v instanceof Uint8Array,
};

/** A protocol.json type: a base type or shape name, [] (list of) and {} (map of) suffixes, ? (optional), a default. */
export interface WireType {
  base: string;
  /** Outermost first: "[]" or "{}". */
  wrap: string[];
  optional: boolean;
  /** "frames?all": "all". */
  fallback?: string;
}

const isShape = (name: string) => Object.hasOwn(PROTOCOL.shapes ?? {}, name);

export function parseType(t: string): WireType {
  const m = /^([A-Za-z]+)((?:\[\]|\{\})*)(\??)([a-z]*)$/.exec(t);
  if (!m) throw new Error(`protocol.json: malformed type '${t}'`);
  if (!CHECKS[m[1]] && !isShape(m[1])) throw new Error(`protocol.json: unknown type '${m[1]}'`);
  const wrap = (m[2].match(/\[\]|\{\}/g) ?? []).reverse();
  return { base: m[1], wrap, optional: m[3] === "?", fallback: m[4] || undefined };
}

/** A shape's fields, with the fields of the shape it includes ("...": "Other"). */
export function shapeFields(name: string): Record<string, string> {
  const shape = PROTOCOL.shapes?.[name];
  if (!shape) throw new Error(`protocol.json: unknown shape '${name}'`);
  const { "...": base, ...own } = shape;
  return base ? { ...shapeFields(base), ...own } : own;
}

const MAX_DEPTH = 32;
const article = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
function describeType(w: WireType): string {
  if (w.wrap[0] === "[]") return "an array";
  if (w.wrap[0] === "{}") return "an object";
  if (isShape(w.base)) return `an object (${w.base})`;
  return w.base === "frames" ? "a frame spec" : article(w.base);
}

/** One value against a parsed type; path is the param path for messages ('attachments[0].path'). */
function checkValue(where: string, path: string, w: WireType, v: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`${where}: '${path}' is nested too deeply`);
  const [outer, ...inner] = w.wrap;
  const rest = { ...w, wrap: inner };
  const fail = () => new Error(`${where}: '${path}' must be ${describeType(w)}`);
  if (outer === "[]") {
    if (isEmptyObject(v)) return;
    if (!isList(v)) throw fail();
    v.forEach((x, i) => checkValue(where, `${path}[${i}]`, rest, x, depth + 1));
  } else if (outer === "{}") {
    if (isEmptyList(v)) return;
    if (!isObject(v)) throw fail();
    for (const [k, x] of Object.entries(v)) checkValue(where, `${path}.${k}`, rest, x, depth + 1);
  } else if (CHECKS[w.base]) {
    if (!CHECKS[w.base](v)) throw fail();
  } else {
    if (isEmptyList(v)) v = {};
    if (!isObject(v)) throw fail();
    checkFields(where, shapeFields(w.base), v, `${path}.`, false, depth + 1);
  }
}

/**
 * Fields against field -> type: unknown fields (except scope, where allowed), missing required ones and wrong
 * types. Undefined and null count as missing: JSON drops undefined, and Lua has no null.
 */
function checkFields(where: string, fields: Record<string, string>, obj: Record<string, unknown>, prefix: string, allowScope: boolean, depth: number): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && !Object.hasOwn(fields, k) && !(allowScope && k === "scope")) {
      throw new Error(`${where}: unknown param '${prefix}${k}'`);
    }
  }
  for (const [name, type] of Object.entries(fields)) {
    const w = parseType(type);
    const v = obj[name];
    if (v === undefined || v === null) {
      if (!w.optional) throw new Error(`${where}: '${prefix}${name}' is required`);
    } else checkValue(where, `${prefix}${name}`, w, v, depth);
  }
}

/**
 * A request's params against protocol.json: unknown or missing params and wrong types. The extension does this
 * on arrival (wire_params.lua), where it also resolves layer and frame references against the live sprite, so the
 * bridge does not check again before sending (#96). The fake document runs this in the extension's place.
 */
export function checkParams(method: string, params: Record<string, unknown> = {}): void {
  const schema = PROTOCOL.requests[method]?.params;
  if (!schema) throw new Error(`Not a protocol request: ${method}`);
  checkFields(method, schema, params, "", true, 0);
}

/** The params of a bridge method the extension called (protocol.json bridgeMethods), checked on arrival (#96). */
export function checkBridgeParams(method: string, params: unknown): void {
  const schema = PROTOCOL.bridgeMethods[method]?.params;
  if (!schema) throw new Error(`Not a bridge method: ${method}`);
  if (params === undefined || params === null || isEmptyList(params)) params = {};
  if (!isObject(params)) throw new Error(`${method}: params must be an object`);
  checkFields(method, schema, params, "", false, 0);
}

/** A value against a shape of protocol.json, e.g. checkShape("State", reply) for get_state. */
export function checkShape(name: string, value: unknown, where = name): void {
  checkValue(where, "result", { base: name, wrap: [], optional: false }, value, 0);
}

/** A request's result, when protocol.json types it (get_state: State), checked as it arrives (#96). */
export function checkResult(method: string, result: unknown): void {
  const type = PROTOCOL.requests[method]?.result;
  if (type) checkValue(`${method} result`, "result", parseType(type), result, 0);
}

/** A {offset, length} reference into a request's binary frame (protocol.json binaryRequests). */
export interface BinaryRef {
  offset: number;
  length: number;
}

const BYTES_DEPTH = 8;

/** Params with every raw byte value replaced by fn(bytes), deeply (arrays and plain objects); the input is left as is. */
function mapBytes(v: unknown, fn: (b: Uint8Array) => unknown, depth = 0): unknown {
  if (v instanceof Uint8Array) return fn(v);
  if (depth > BYTES_DEPTH || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => mapBytes(x, fn, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = mapBytes(x, fn, depth + 1);
  return out;
}

const hasBytes = (v: unknown, depth = 0): boolean =>
  v instanceof Uint8Array ||
  (depth <= BYTES_DEPTH && v !== null && typeof v === "object" && Object.values(v).some((x) => hasBytes(x, depth + 1)));

/**
 * WebSocket framing of raw bytes (#95): every Uint8Array in params becomes
 * {offset, length} into one blob, sent as the binary frame that follows the
 * request (protocol.json binaryRequests). blob is undefined when params hold
 * no bytes (then params come back unchanged).
 */
export function packBinary(params: Record<string, unknown>): { params: Record<string, unknown>; blob?: Buffer } {
  if (!hasBytes(params)) return { params };
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const packed = mapBytes(params, (b): BinaryRef => {
    chunks.push(b);
    const ref = { offset, length: b.byteLength };
    offset += b.byteLength;
    return ref;
  }) as Record<string, unknown>;
  return { params: packed, blob: Buffer.concat(chunks, offset) };
}

/** Raw bytes in params as base64 text, for transports without binary frames (the Headless runner's JSON lines). */
export function base64Bytes(params: Record<string, unknown>): Record<string, unknown> {
  if (!hasBytes(params)) return params;
  return mapBytes(params, (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64")) as Record<string, unknown>;
}
