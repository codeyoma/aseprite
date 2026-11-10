// ACP runtime: runs an Agent Client Protocol agent (claude-agent-acp,
// codex-acp) as a long-lived process. One session per conversation; each
// chat message is a session/prompt, Stop is session/cancel, and a bridge
// restart continues the conversation with session/load.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { log } from "./aseprite.js";
import { MCP_SERVER_NAME, type AgentProvider } from "./providers/agent_provider.js";
import { AcpMapper, type AcpEvent } from "./providers/acp_mapper.js";

export interface AcpEndpoint {
  url: string;
  token: string;
}

/** A permission the agent asks for, and the options it offers. */
export interface PermissionRequest {
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}
export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpHandlers {
  onEvent(ev: AcpEvent): void;
  onPermission(req: PermissionRequest): Promise<PermissionOutcome>;
}

const require = createRequire(import.meta.url);

/** Command to start a provider's ACP agent, or undefined if it isn't installed. */
export function acpCommand(provider: AgentProvider): { command: string; args: string[] } | undefined {
  if (!provider.acp) return undefined;
  try {
    const pkgJson = require.resolve(`${provider.acp.package}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[provider.acp.bin];
    if (!rel) return undefined;
    const script = join(dirname(pkgJson), rel);
    if (!existsSync(script)) return undefined;
    return { command: process.execPath, args: [script] };
  } catch {
    return undefined;
  }
}

export class AcpRunner {
  private proc?: ChildProcess;
  private agent?: any; // ClientContext
  private sessions = new Set<string>(); // sessions this process created or loaded
  private loadSupported = false;
  private loading = false;
  private mapper = new AcpMapper();
  private current?: string; // session of the running prompt

  constructor(
    private readonly provider: AgentProvider,
    private readonly endpoint: AcpEndpoint,
    private readonly cwd: string,
    private readonly systemPrompt: string,
    private readonly handlers: AcpHandlers,
    private readonly recordFile?: string,
  ) {}

  private mcpServers() {
    return [
      {
        type: "http",
        name: MCP_SERVER_NAME,
        url: this.endpoint.url,
        headers: [{ name: "Authorization", value: `Bearer ${this.endpoint.token}` }],
      },
    ];
  }

  private record(direction: string, chunk: Uint8Array) {
    if (this.recordFile) appendFileSync(this.recordFile, `${direction} ${new TextDecoder().decode(chunk)}`);
  }

  private async start(): Promise<void> {
    if (this.agent) return;
    const cmd = acpCommand(this.provider);
    if (!cmd) throw new Error(`${this.provider.acp?.package ?? this.provider.id} is not installed`);

    const proc = spawn(cmd.command, cmd.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.provider.acp!.env(this.systemPrompt) },
    });
    this.proc = proc;
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    proc.on("exit", (code) => {
      log(`acp: ${this.provider.id} agent exited (${code})`);
      if (this.proc === proc) {
        this.proc = undefined;
        this.agent = undefined;
        this.sessions.clear();
      }
    });

    const tee = (dir: string) =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, c) => {
          this.record(dir, chunk);
          c.enqueue(chunk);
        },
      });
    const toAgent = tee(">");
    toAgent.readable.pipeTo(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>).catch(() => {});
    const fromAgent = (Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>).pipeThrough(tee("<"));

    const app = client({ name: "aseprite-agent" })
      // Handlers get a context; the notification or request is ctx.params.
      .onNotification("session/update", ({ params: p }: any) => {
        if (this.loading || p.sessionId !== this.current) return;
        for (const ev of this.mapper.map(p.update)) this.handlers.onEvent(ev);
      })
      .onRequest("session/request_permission", async ({ params: p }: any) => {
        const title = p.toolCall?.title ?? p.toolCall?.toolCallId ?? "a tool";
        return { outcome: await this.handlers.onPermission({ title, options: p.options ?? [] }) };
      });
    const conn = app.connect(ndJsonStream(toAgent.writable, fromAgent));
    this.agent = conn.agent;

    try {
      const init = await this.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      this.loadSupported = !!init.agentCapabilities?.loadSession;
    } catch (err) {
      this.dispose();
      throw new Error(`${this.provider.id} ACP agent failed to start: ${String(err)} ${stderr.slice(-500)}`);
    }
  }

  /** Session for a conversation: reuse, load (after a restart) or create. */
  private async session(conversationId?: string): Promise<string> {
    const params = { cwd: this.cwd, mcpServers: this.mcpServers(), _meta: this.provider.acp!.sessionMeta(this.systemPrompt) };
    if (conversationId && this.sessions.has(conversationId)) return conversationId;
    if (conversationId && this.loadSupported) {
      this.loading = true; // the agent replays history as updates; don't show it again
      try {
        await this.agent.request("session/load", { ...params, sessionId: conversationId });
        this.sessions.add(conversationId);
        return conversationId;
      } catch (err) {
        log(`acp: session/load failed (${String(err)}); starting a new session`);
      } finally {
        this.loading = false;
      }
    }
    const { sessionId } = await this.agent.request("session/new", params);
    this.sessions.add(sessionId);
    return sessionId;
  }

  /** Runs one message. Resolves when the turn ends. */
  async prompt(message: string, conversationId?: string): Promise<{ conversationId: string; stopReason: string }> {
    await this.start();
    const sessionId = await this.session(conversationId);
    this.mapper = new AcpMapper();
    this.current = sessionId;
    try {
      const res = await this.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] });
      for (const ev of this.mapper.flush()) this.handlers.onEvent(ev);
      return { conversationId: sessionId, stopReason: res?.stopReason ?? "end_turn" };
    } finally {
      this.current = undefined;
    }
  }

  /** Stops the running turn; the session stays usable. */
  async cancel(): Promise<void> {
    if (this.agent && this.current) await this.agent.notify("session/cancel", { sessionId: this.current });
  }

  dispose(): void {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
    this.agent = undefined;
    this.sessions.clear();
  }
}
