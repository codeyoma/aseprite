// The runtime seam behind ChatRunner (#55): one way to run an agent turn,
// with two adapters. AcpRuntime keeps a long-lived ACP agent per
// conversation key; StreamRuntime starts the provider's CLI per turn and
// reads its stream-json output. ChatRunner owns everything else (keys, the
// message, busy state, terminal events, permissions).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AcpRunner, acpCommand, type ChatMode, type PermissionOutcome, type PermissionRequest } from "./acp.js";
import { log } from "./aseprite.js";
import type { ImageBlock } from "./attachments.js";
import type { HttpEndpoint } from "./http.js";
import type { AcpEvent } from "./providers/acp_mapper.js";
import type { AgentProvider, ProviderEvent } from "./providers/index.js";

export interface Turn {
  /** Conversation key: the provider id, or "<id>:dev" in Developer mode. */
  key: string;
  provider: AgentProvider;
  message: string;
  conversationId?: string;
  images: ImageBlock[];
  mode: ChatMode;
  cwd: string;
  systemPrompt: string;
  /** The panel's chat: each chat has its own agent process and MCP address, so chats run at the same time. */
  chatId?: string;
}

/** Where a runtime reports what happens during a turn. */
export interface TurnSink {
  event(ev: ProviderEvent | AcpEvent): void;
  permission(req: PermissionRequest): Promise<PermissionOutcome>;
}

/**
 * How a turn ended. "early": the agent stopped for another reason (detail
 * says which). Failures reject with an Error whose message the panel shows.
 */
export interface TurnResult {
  conversationId?: string;
  stop: "end" | "cancelled" | "early";
  detail?: string;
}

export interface WarmRequest {
  key: string;
  chatId?: string;
  provider: AgentProvider;
  mode: ChatMode;
  cwd: string;
  systemPrompt: string;
}

export interface Runtime {
  readonly name: "acp" | "stream";
  /** Whether this runtime can run the provider at all. */
  supports(provider: AgentProvider): boolean;
  start(turn: Turn, sink: TurnSink): Promise<TurnResult>;
  /** Optional: start the agent and a spare session ahead of the first turn (#87). */
  warm?(w: WarmRequest): Promise<void>;
  /** Cancels the running turn of a runner key (all when omitted); its start() then settles as "cancelled". Safe to call twice. */
  stop(key?: string): void;
  dispose(): void;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export { which } from "./platform.js";
import { which } from "./platform.js";

/** ACP: one long-lived agent per conversation key, prompted per turn. */
/** A runner per chat and conversation key. */
export const runnerKey = (key: string, chatId?: string) => (chatId ? `${chatId}|${key}` : key);

/** The endpoint with the chat in its MCP addresses, so the bridge knows which chat a tool call belongs to. */
export function chatEndpoint<E extends { url: string; askUrl?: string; token: string }>(endpoint: E, chatId?: string): E {
  if (!chatId) return endpoint;
  const q = (u?: string) => (u ? `${u}${u.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chatId)}` : u);
  return { ...endpoint, url: q(endpoint.url)!, askUrl: q(endpoint.askUrl) };
}

export class AcpRuntime implements Runtime {
  readonly name = "acp";
  private runners = new Map<string, AcpRunner>();
  private sinks = new Map<string, TurnSink>();
  private cwds = new Map<string, string>(); // each runner's working directory
  private running = new Set<string>(); // runner keys with a turn in progress
  private lastUsed = new Map<string, number>(); // runner key -> when its last turn ended (or it was warmed)
  private sweeper?: NodeJS.Timeout;

  /** A chat's agent idle this long is stopped (each chat has its own process, #90); its conversation reloads on the next turn. */
  static IDLE_MS = 15 * 60_000;

  constructor(private readonly endpoint: HttpEndpoint, private readonly recordDir?: string) {}

  /** Stops agents that no turn used for IDLE_MS. */
  private sweep(now = Date.now()): void {
    for (const [key, at] of this.lastUsed) {
      if (this.running.has(key) || now - at < AcpRuntime.IDLE_MS) continue;
      this.runners.get(key)?.dispose();
      this.runners.delete(key);
      this.lastUsed.delete(key);
      log(`acp: stopped the idle agent ${key}`);
    }
  }

  private touch(key: string): void {
    this.lastUsed.set(key, Date.now());
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), 60_000);
      this.sweeper.unref();
    }
  }

  supports(provider: AgentProvider): boolean {
    return acpCommand(provider) !== undefined;
  }

  async start(turn: Turn, sink: TurnSink): Promise<TurnResult> {
    const developer = turn.mode === "developer";
    // Each chat has its own runner (agent process), so chats' turns run at the same time.
    const key = runnerKey(turn.key, turn.chatId);
    this.sinks.set(key, sink);
    let runner = this.runners.get(key);
    // A new developer worktree: a new agent there, and a new conversation
    // (the old one's files were in the other folder).
    if (runner && this.cwds.get(key) !== turn.cwd) {
      runner.dispose();
      this.runners.delete(key);
      runner = undefined;
      turn = { ...turn, conversationId: undefined };
    }
    if (!runner) runner = this.runner(key, turn.provider, turn.cwd, turn.systemPrompt, developer, turn.chatId);
    this.running.add(key);
    try {
      const { conversationId, stopReason } = await runner.prompt(turn.message, turn.conversationId, turn.images, developer ? "agent" : turn.mode);
      if (stopReason === "cancelled") return { conversationId, stop: "cancelled" };
      if (stopReason === "end_turn") return { conversationId, stop: "end" };
      return { conversationId, stop: "early", detail: stopReason };
    } finally {
      this.running.delete(key);
      this.touch(key);
    }
  }

  /** The runner of a conversation key, made on first use. */
  private runner(key: string, provider: AgentProvider, cwd: string, systemPrompt: string, developer: boolean, chatId?: string): AcpRunner {
    let runner = this.runners.get(key);
    if (runner) return runner;
    const record = this.recordDir ? join(this.recordDir, `acp-${key.replace(/[:|]/g, "-")}-${stamp()}.jsonl`) : undefined;
    // Events go to the sink of the turn running on this key; its tool calls
    // name the chat in their MCP address (http.ts reads ?chat=).
    runner = new AcpRunner(provider, chatEndpoint(this.endpoint, chatId), cwd, systemPrompt, {
      onEvent: (ev) => this.sinks.get(key)?.event(ev),
      onPermission: (req) => this.sinks.get(key)?.permission(req) ?? Promise.resolve({ outcome: "cancelled" } as PermissionOutcome),
    }, record, developer);
    this.runners.set(key, runner);
    this.cwds.set(key, cwd);
    return runner;
  }

  async warm(w: WarmRequest): Promise<void> {
    if (w.mode === "developer") return;
    const key = runnerKey(w.key, w.chatId);
    this.touch(key);
    await this.runner(key, w.provider, w.cwd, w.systemPrompt, false, w.chatId).warm(w.mode);
  }

  stop(key?: string): void {
    for (const k of key ? [key] : [...this.running]) void this.runners.get(k)?.cancel();
  }

  dispose(): void {
    for (const r of this.runners.values()) r.dispose();
    this.runners.clear();
    if (this.sweeper) clearInterval(this.sweeper);
  }
}

/** stream-json: the provider's CLI per turn, text only. */
export class StreamRuntime implements Runtime {
  readonly name = "stream";
  private proc?: ChildProcess;
  private cancel?: () => void;

  constructor(private readonly endpoint: HttpEndpoint, private readonly recordDir?: string) {}

  supports(provider: AgentProvider): boolean {
    return which(provider.executable) !== undefined;
  }

  start(turn: Turn, sink: TurnSink): Promise<TurnResult> {
    const bin = which(turn.provider.executable);
    if (!bin) return Promise.reject(new Error(`${turn.provider.executable} CLI not found on PATH`));
    if (turn.mode === "developer") return Promise.reject(new Error("Developer mode needs the ACP runtime (unset ASEPRITE_AGENT_RUNTIME)"));
    let message = turn.message;
    if (turn.images.length) message += `\n\n(${turn.images.length} attached image(s) could not be sent: the stream runtime is text only.)`;
    const args = turn.provider.command({
      message,
      conversationId: turn.conversationId,
      mcpUrl: turn.mode === "agent" ? this.endpoint.url : this.endpoint.askUrl,
      mcpToken: this.endpoint.token,
      systemPrompt: turn.systemPrompt,
    });
    const parse = turn.provider.parser();
    const record = this.recordDir ? join(this.recordDir, `${turn.provider.id}-${stamp()}.jsonl`) : undefined;
    const proc = spawn(bin, args, { cwd: turn.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.proc = proc;
    let conversationId = turn.conversationId;

    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.proc === proc) {
          this.proc = undefined;
          this.cancel = undefined;
        }
        fn();
      };
      // Stopping reports at once; the process's own exit is then ignored.
      this.cancel = () => {
        proc.kill("SIGTERM");
        settle(() => resolve({ conversationId, stop: "cancelled" }));
      };
      let stderr = "";
      proc.stderr!.on("data", (d) => {
        stderr = (stderr + d).slice(-2000);
      });
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        if (settled || !line.trim()) return;
        if (record) appendFileSync(record, line + "\n");
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return;
        }
        try {
          for (const ev of parse(json)) {
            if (ev.type === "conversation") conversationId = ev.id;
            sink.event(ev);
          }
        } catch (err) {
          log(`chat: bad event: ${String(err)}`);
        }
      });
      proc.on("close", (code) => {
        log(`chat: ${turn.provider.id} finished with code ${code}`);
        if (code === 0) settle(() => resolve({ conversationId, stop: "end" }));
        else settle(() => reject(new Error(`${turn.provider.id} exited with code ${code}. ${stderr.trim().split("\n").slice(-3).join(" ")}`)));
      });
      proc.on("error", (err) => settle(() => reject(err)));
    });
  }

  stop(): void {
    this.cancel?.();
  }

  dispose(): void {
    this.stop();
  }
}
