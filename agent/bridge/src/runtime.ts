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
  /** Cancels the running turn (its start() then settles as "cancelled"). Safe to call twice. */
  stop(): void;
  dispose(): void;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function which(cmd: string): string | undefined {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : undefined;
}

/** ACP: one long-lived agent per conversation key, prompted per turn. */
export class AcpRuntime implements Runtime {
  readonly name = "acp";
  private runners = new Map<string, AcpRunner>();
  private sinks = new Map<string, TurnSink>();
  private cwds = new Map<string, string>(); // each runner's working directory
  private current?: string;

  constructor(private readonly endpoint: HttpEndpoint, private readonly recordDir?: string) {}

  supports(provider: AgentProvider): boolean {
    return acpCommand(provider) !== undefined;
  }

  async start(turn: Turn, sink: TurnSink): Promise<TurnResult> {
    const developer = turn.mode === "developer";
    this.sinks.set(turn.key, sink);
    let runner = this.runners.get(turn.key);
    // A new developer worktree: a new agent there, and a new conversation
    // (the old one's files were in the other folder).
    if (runner && this.cwds.get(turn.key) !== turn.cwd) {
      runner.dispose();
      this.runners.delete(turn.key);
      runner = undefined;
      turn = { ...turn, conversationId: undefined };
    }
    if (!runner) runner = this.runner(turn.key, turn.provider, turn.cwd, turn.systemPrompt, developer);
    this.current = turn.key;
    try {
      const { conversationId, stopReason } = await runner.prompt(turn.message, turn.conversationId, turn.images, developer ? "agent" : turn.mode);
      if (stopReason === "cancelled") return { conversationId, stop: "cancelled" };
      if (stopReason === "end_turn") return { conversationId, stop: "end" };
      return { conversationId, stop: "early", detail: stopReason };
    } finally {
      if (this.current === turn.key) this.current = undefined;
    }
  }

  /** The runner of a conversation key, made on first use. */
  private runner(key: string, provider: AgentProvider, cwd: string, systemPrompt: string, developer: boolean): AcpRunner {
    let runner = this.runners.get(key);
    if (runner) return runner;
    const record = this.recordDir ? join(this.recordDir, `acp-${key.replace(":", "-")}-${stamp()}.jsonl`) : undefined;
    // Events go to the sink of the turn running on this key.
    runner = new AcpRunner(provider, this.endpoint, cwd, systemPrompt, {
      onEvent: (ev) => this.sinks.get(key)?.event(ev),
      onPermission: (req) => this.sinks.get(key)?.permission(req) ?? Promise.resolve({ outcome: "cancelled" } as PermissionOutcome),
    }, record, developer);
    this.runners.set(key, runner);
    this.cwds.set(key, cwd);
    return runner;
  }

  async warm(w: WarmRequest): Promise<void> {
    if (w.mode === "developer") return;
    await this.runner(w.key, w.provider, w.cwd, w.systemPrompt, false).warm(w.mode);
  }

  stop(): void {
    if (this.current) void this.runners.get(this.current)?.cancel();
  }

  dispose(): void {
    for (const r of this.runners.values()) r.dispose();
    this.runners.clear();
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
