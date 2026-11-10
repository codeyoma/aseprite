import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { keepSessionPublished, newToken, removeSession, writeSession, type Session } from "./session.js";

const HELLO_TIMEOUT_MS = 5_000;

interface Pending {
  method: string;
  resolve: (value: Reply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Reply {
  result: any;
  binary?: Buffer;
}

export class AsepriteNotConnectedError extends Error {
  constructor() {
    super(
      "Aseprite is not connected. Open Aseprite with the Aseprite Agent extension installed. " +
        "It connects automatically; if not, use File > Scripts > AI Agent > Connect, " +
        "and allow the file and network access prompts.",
    );
  }
}

/**
 * WebSocket server that the Aseprite extension connects to.
 * Requests are JSON-RPC 2.0; a result with `binary: true` is followed by
 * one binary frame carrying raw pixel data.
 */
export class AsepriteLink extends EventEmitter {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private awaitingBinary?: { id: number; result: any };
  private readonly token = newToken();
  private republishTimer?: NodeJS.Timeout;
  private inbound = new Map<string, (params: any) => Promise<unknown> | unknown>();
  /** Extra fields published in the session file (e.g. bridgePath). */
  sessionExtra: Record<string, unknown> = {};
  asepriteVersion?: string;

  get connected(): boolean {
    return this.client?.readyState === WebSocket.OPEN && this.asepriteVersion !== undefined;
  }

  async start(port = 0): Promise<number> {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port,
      // Browsers always send an http(s) Origin. Aseprite (ixwebsocket) sends
      // none or its own ws:// URL. Rejecting web origins stops pages from attaching.
      verifyClient: (info: { origin?: string; req: { headers: Record<string, unknown> } }) => {
        const ok = !info.origin || !/^https?:/i.test(info.origin);
        if (!ok) log(`rejected connection from origin ${info.origin}`);
        return ok;
      },
    });
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", resolve);
      this.wss!.once("error", reject);
    });
    const actualPort = (this.wss.address() as AddressInfo).port;
    this.wss.on("connection", (socket) => this.onConnection(socket));

    const session: Session = {
      port: actualPort,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...this.sessionExtra,
    };
    writeSession(session);
    this.republishTimer = keepSessionPublished(session);
    return actualPort;
  }

  stop(): void {
    if (this.republishTimer) clearInterval(this.republishTimer);
    removeSession(process.pid);
    this.client?.close();
    this.wss?.close();
  }

  private onConnection(socket: WebSocket): void {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) {
        log("rejected connection: no hello within timeout");
        socket.close(4001, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!authed) {
        if (isBinary) return socket.close(4002, "expected hello");
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return socket.close(4002, "bad hello");
        }
        if (msg?.method !== "hello" || msg?.params?.token !== this.token) {
          log(`rejected connection: bad hello (${msg?.method ?? "no method"})`);
          return socket.close(4003, "bad token");
        }
        authed = true;
        clearTimeout(helloTimer);
        // A newer Aseprite connection replaces the previous one.
        if (this.client && this.client !== socket) this.client.close(4000, "replaced");
        this.client = socket;
        this.asepriteVersion = String(msg.params.asepriteVersion ?? "unknown");
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "welcome", params: {} }));
        log(`Aseprite ${this.asepriteVersion} connected`);
        this.emit("connected");
        return;
      }
      this.onMessage(data, isBinary);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (this.client === socket) {
        this.client = undefined;
        this.asepriteVersion = undefined;
        this.awaitingBinary = undefined;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`Aseprite disconnected during ${p.method}`));
          this.pending.delete(id);
        }
        log("Aseprite disconnected");
      }
    });
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      const waiting = this.awaitingBinary;
      this.awaitingBinary = undefined;
      if (!waiting) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.settle(waiting.id, { result: waiting.result, binary: buf });
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // A request or notification initiated by the extension (e.g. chat).
    if (typeof msg?.method === "string") {
      void this.handleInbound(msg);
      return;
    }
    if (typeof msg?.id !== "number") return;

    if (msg.error) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.reject(new Error(msg.error.message ?? "Aseprite error"));
      return;
    }
    if (msg.result?.binary) {
      this.awaitingBinary = { id: msg.id, result: msg.result };
      return;
    }
    this.settle(msg.id, { result: msg.result });
  }

  /** Handle a request the extension sends to the bridge. */
  onRequest(method: string, handler: (params: any) => Promise<unknown> | unknown): void {
    this.inbound.set(method, handler);
  }

  /** Send a notification to the extension (no reply expected). */
  notify(method: string, params: Record<string, unknown>): void {
    if (this.connected) this.client!.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private async handleInbound(msg: any): Promise<void> {
    const handler = this.inbound.get(msg.method);
    const reply = (body: Record<string, unknown>) => {
      if (msg.id !== undefined && this.client?.readyState === WebSocket.OPEN) {
        this.client.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
      }
    };
    if (!handler) return reply({ error: { code: -32601, message: `Unknown method: ${msg.method}` } });
    try {
      reply({ result: (await handler(msg.params ?? {})) ?? null });
    } catch (err) {
      reply({ error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private settle(id: number, reply: Reply): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(reply);
  }

  /** Wait briefly for Aseprite to connect, e.g. right after the bridge starts. */
  async waitForConnection(ms: number): Promise<boolean> {
    if (this.connected) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("connected", onConnected);
        resolve(false);
      }, ms);
      const onConnected = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once("connected", onConnected);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Reply> {
    if (!(await this.waitForConnection(3_000))) throw new AsepriteNotConnectedError();
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Aseprite did not answer ${method} within ${timeoutMs / 1000}s (a modal dialog may be open)`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.client!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}

export function log(message: string): void {
  // stdout carries MCP traffic, so logs go to stderr.
  process.stderr.write(`[aseprite-agent] ${message}\n`);
}
