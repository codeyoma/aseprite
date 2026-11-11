// The Headless runner (#85): one long-lived `aseprite -b` running
// extension/headless_runner.lua, which loads the same Document Handlers and
// protocol.json as the live extension and keeps documents in memory. This
// side spawns it and speaks JSON lines over its stdin/stdout:
//
//   request  {"id": 1, "method": "snapshot", "params": {...}}
//   reply    MARK + {"id": 1, "result": {...}, "binary": "<base64>"} | {"id": 1, "error": {"message"}}
//
// HeadlessLink is an AsepriteRequester, so the tools run on it unchanged.
// The mode is only ever chosen explicitly (`ase --headless`,
// ASEPRITE_AGENT_MODE=headless), never as a fallback for a missing window.
// It refuses files the live window has open: liveOpenFiles asks the newest
// live bridge (session.json) through its token-protected GET /files.
// Adapted from aseprite-ai-artist's headless mode (MIT, ADR-0008).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import type { Reply } from "./aseprite.js";
import type { RequestRoute } from "./tool.js";
import { base64Bytes, checkResult, isRequest, PROTOCOL } from "./protocol.js";
import { sessionFile } from "./session.js";

/** Starts every reply line, so stray lines Aseprite prints are never read as replies. */
export const MARK = "\x1ease ";

/** Requests only the runner answers (not in protocol.json). */
export const RUNNER_METHODS = new Set(["open", "close", "shutdown"]);

export interface HeadlessRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
  /** The sprite the request acts on (#90): a sprite id from get_state; default the active sprite. */
  doc?: string;
}

export interface HeadlessReply {
  id?: number | null;
  result?: any;
  error?: { message: string; code?: number };
  binary?: string;
  hello?: { protocol: number; aseprite: string };
}

/** One request line. */
export function encodeRequest(req: HeadlessRequest): string {
  return JSON.stringify(req) + "\n";
}

/**
 * Splits stdout chunks into lines. Marked lines are replies; unmarked ones
 * (Aseprite's own output) go to `other`. A line split across chunks waits
 * for its end.
 */
export class LineDecoder {
  private buf = "";
  constructor(private readonly onReply: (r: HeadlessReply) => void, private readonly other: (line: string) => void = () => {}) {}

  push(chunk: string | Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      const at = line.indexOf(MARK);
      if (at < 0) {
        if (line) this.other(line);
        continue;
      }
      let msg: HeadlessReply;
      try {
        msg = JSON.parse(line.slice(at + MARK.length));
      } catch {
        this.other(line);
        continue;
      }
      this.onReply(msg);
    }
  }
}

interface Pending {
  method: string;
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HeadlessOptions {
  /** The aseprite executable. */
  bin: string;
  /** The extension folder (document_handlers.lua, headless_runner.lua, protocol.json). */
  extensionDir: string;
  /** Files the live window has open; open() refuses them. Default: ask the live bridge. */
  liveFiles?: () => Promise<string[]>;
  startTimeoutMs?: number;
}

export class HeadlessLink {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private exited?: string;
  private live?: Set<string>;
  readonly stderr: string[] = [];
  asepriteVersion?: string;

  constructor(private readonly opts: HeadlessOptions) {}

  /** Spawns the runner and waits for its hello. */
  async start(): Promise<void> {
    const { bin, extensionDir } = this.opts;
    const script = resolve(extensionDir, "headless_runner.lua");
    const child = spawn(bin, ["-b", "--script-param", `ext=${extensionDir}`, "--script", script], { stdio: "pipe" });
    this.child = child;
    child.stderr.on("data", (d) => this.stderr.push(d.toString()));
    let hello: (h: NonNullable<HeadlessReply["hello"]>) => void = () => {};
    const helloP = new Promise<NonNullable<HeadlessReply["hello"]>>((res) => (hello = res));
    const decoder = new LineDecoder((msg) => {
      if (msg.hello) return hello(msg.hello);
      this.settle(msg);
    }, (line) => this.stderr.push(line));
    child.stdout.on("data", (d) => decoder.push(d));
    const exitP = new Promise<never>((_, reject) => {
      child.on("error", (e) => this.fail(`could not start ${bin}: ${e.message}`, reject));
      child.on("exit", (code, sig) => this.fail(`exited (${sig ?? code})${this.stderr.length ? ": " + this.stderr.join("").trim().slice(-500) : ""}`, reject));
    });
    exitP.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The headless Aseprite did not start in time")), this.opts.startTimeoutMs ?? 20_000);
    });
    try {
      const h = await Promise.race([helloP, exitP, timeout]);
      if (h.protocol !== PROTOCOL.version) {
        throw new Error(`The headless runner speaks protocol ${h.protocol}, this bridge ${PROTOCOL.version}`);
      }
      this.asepriteVersion = h.aseprite;
    } catch (e) {
      child.kill();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(reason: string, reject?: (e: Error) => void): void {
    this.exited ??= reason;
    const err = new Error(`The headless Aseprite ${this.exited}`);
    reject?.(err);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private settle(msg: HeadlessReply): void {
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id as number);
    if (msg.error) p.reject(new Error(msg.error.message ?? "Aseprite error"));
    else {
      // A typed result (get_state's State) is checked as it arrives, as AsepriteLink does (#96).
      try {
        checkResult(p.method, msg.result);
      } catch (err) {
        p.reject(err as Error);
        return;
      }
      p.resolve({ result: msg.result, binary: msg.binary !== undefined ? Buffer.from(msg.binary, "base64") : undefined });
    }
  }

  /** A protocol request (or a runner one: open, close, shutdown). Same shape as AsepriteLink.request. */
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000, route?: RequestRoute): Promise<Reply> {
    if (RUNNER_METHODS.has(method)) {
      if (method === "open") return Promise.reject(new Error("Use HeadlessLink.open, which checks the live window"));
    } else {
      // Params are checked by the runner's handlers on arrival (wire_params.lua), as in the live window (#96).
      if (!isRequest(method)) return Promise.reject(new Error(`Not a protocol request: ${method}`));
    }
    // Only the sprite (doc) matters to the runner; there are no chats here.
    return this.send(method, params, timeoutMs, route?.doc);
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number, doc?: string): Promise<Reply> {
    if (this.exited || !this.child) return Promise.reject(new Error(`The headless Aseprite ${this.exited ?? "is not running"}`));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The headless Aseprite did not answer ${method} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      // JSON lines carry no binary frames: raw bytes go as base64 (#95).
      this.child!.stdin.write(encodeRequest({ id, method, params: base64Bytes(params), ...(doc ? { doc } : {}) }));
    });
  }

  /** Opens a file and makes it active; refuses one the live window has open. */
  async open(path: string): Promise<{ filename: string; width: number; height: number; frames: number; layers: number }> {
    const file = resolve(path);
    if (!this.live) this.live = new Set((await (this.opts.liveFiles ?? (() => liveOpenFiles()))()).map((f) => resolve(f)));
    if (this.live.has(file)) {
      throw new LiveFileError(file);
    }
    return (await this.send("open", { path: file }, 60_000)).result;
  }

  /** Closes a file (or the active sprite) without saving. */
  async close(path?: string): Promise<void> {
    await this.send("close", path ? { path: resolve(path) } : {}, 60_000);
  }

  /** Asks the runner to exit and waits for it (kills it after timeoutMs). */
  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const gone = new Promise<void>((res) => child.once("exit", () => res()));
    try {
      await this.send("shutdown", {}, timeoutMs);
    } catch {
      // Already gone or stuck: the kill below handles it.
    }
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    await gone;
    clearTimeout(timer);
  }
}

export class LiveFileError extends Error {
  constructor(readonly file: string) {
    super(`${file} is open in the live Aseprite window`);
  }
}

/**
 * The files the live Aseprite has open, from the newest live bridge
 * (session.json) through GET /files with its token. No session file or a
 * closed port: no live window, so nothing is open. Other failures throw:
 * headless must not touch a file it cannot prove is free.
 */
export async function liveOpenFiles(opts: { session?: string; timeoutMs?: number } = {}): Promise<string[]> {
  let session: { port?: number; token?: string };
  try {
    session = JSON.parse(readFileSync(opts.session ?? sessionFile, "utf8"));
  } catch {
    return [];
  }
  if (!session.port || !session.token) return [];
  const get = (path: string) => httpGet(session.port!, path, session.token!, opts.timeoutMs ?? 3_000);
  const files = await get("/files");
  if (files === undefined) return [];
  if (files.status === 200) {
    const list = files.body?.files;
    if (!Array.isArray(list)) throw new Error("the live bridge sent a bad GET /files reply");
    return list.filter((f: unknown) => typeof f === "string" && f);
  }
  // A bridge from before GET /files answers 426: it can still say whether a window is attached.
  if (files.status === 426) {
    const status = await get("/status");
    if (status === undefined || (status.status === 200 && status.body?.connected === false)) return [];
    throw new Error("the live bridge is too old to list the files Aseprite has open; restart it (or close Aseprite)");
  }
  throw new Error(`the live bridge answered ${files.status} to GET /files`);
}

/** GET on the live bridge: status and JSON body, or undefined when nothing listens. */
function httpGet(port: number, path: string, token: string, timeoutMs: number): Promise<{ status: number; body: any } | undefined> {
  return new Promise((resolveP, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${token}` }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let body: any;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          resolveP({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`the live bridge did not answer GET ${path} in time`)));
    req.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNREFUSED" ? resolveP(undefined) : reject(e)));
    req.end();
  });
}

/** Headless mode is on: `--headless`, or ASEPRITE_AGENT_MODE=headless. */
export function headlessRequested(flag: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag === true || env.ASEPRITE_AGENT_MODE === "headless";
}
