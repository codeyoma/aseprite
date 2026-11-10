// Runs an agent CLI for the in-app chat panel and streams its progress to
// Aseprite. The CLI uses the user's own login and connects back to this
// bridge over the localhost HTTP MCP endpoint. Everything provider-specific
// (flags, output format) lives in an Agent Provider adapter (./providers).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AsepriteLink } from "./aseprite.js";
import { log } from "./aseprite.js";
import type { HttpEndpoint } from "./http.js";
import { PROVIDERS, type AgentProvider, type ProviderEvent, type ProviderId } from "./providers/index.js";
import { sessionDir } from "./session.js";
import { describeTool, inputDetail, resultDetail, toolKind } from "./tool_labels.js";

export type { ProviderId as Provider } from "./providers/index.js";

/** What the chat panel receives (method "chat.event"). */
export interface ChatEvent {
  type: "status" | "text" | "thinking" | "tool" | "tool_result" | "done" | "error" | "session";
  text?: string;
  tool?: string;
  /** Matches a tool_result to its tool event. */
  id?: string;
  /** "edit" for tools that change the document, "read" for the rest. */
  kind?: "edit" | "read";
  /** Tool input or result, shortened, for the panel's expandable rows. */
  detail?: string;
  ok?: boolean;
  provider?: ProviderId;
  sessionId?: string;
}

export const SYSTEM_PROMPT = `You are the AI assistant inside Aseprite's "AI Agent" panel. The user is talking to you from inside Aseprite while they draw.
Use the aseprite MCP tools to do what they ask in the open document. Read the guide with read_guide("basics") before your first edit in a conversation.
Each message starts with a [Context] line describing the user's current selection in Aseprite; "this layer", "these frames" and "the selection" refer to it.
After visual changes, check your work with snapshot. Keep replies short: say what you changed in one or two sentences.`;

/** Maps a provider event to the event the panel shows. */
export function toChatEvent(ev: ProviderEvent, provider: ProviderId): ChatEvent {
  switch (ev.type) {
    case "conversation": return { type: "session", provider, sessionId: ev.id };
    case "text": return { type: "text", text: ev.text };
    case "thinking": return { type: "thinking", text: ev.text };
    case "error": return { type: "error", text: ev.text };
    case "tool":
      return { type: "tool", id: ev.id, tool: describeTool(ev.tool, ev.input), kind: toolKind(ev.tool), detail: inputDetail(ev.input) };
    case "tool_result":
      return { type: "tool_result", id: ev.id, tool: ev.tool, ok: ev.ok, detail: resultDetail(ev.content) };
  }
}

function which(cmd: string): string | undefined {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : undefined;
}

export class ChatRunner {
  private proc?: ChildProcess;
  // Conversation ids. The panel owns them (they survive bridge restarts) and
  // passes them with each message; new ones are reported with "session".
  private conversations: Partial<Record<ProviderId, string>> = {};
  private readonly cwd = join(sessionDir, "workspace");

  constructor(
    private readonly link: AsepriteLink,
    private readonly endpoint: HttpEndpoint,
    /** Directory to save raw CLI output to (fixtures); ASEPRITE_AGENT_RECORD. */
    private readonly recordDir = process.env.ASEPRITE_AGENT_RECORD,
  ) {
    mkdirSync(this.cwd, { recursive: true });
    if (this.recordDir) mkdirSync(this.recordDir, { recursive: true });
  }

  get busy(): boolean {
    return this.proc !== undefined;
  }

  providers(): Record<ProviderId, boolean> {
    const out = {} as Record<ProviderId, boolean>;
    for (const p of Object.values(PROVIDERS)) out[p.id] = which(p.executable) !== undefined;
    return out;
  }

  private emit(event: ChatEvent): void {
    this.link.notify("chat.event", event as unknown as Record<string, unknown>);
  }

  reset(): void {
    this.stop();
    this.conversations = {};
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = undefined;
      this.emit({ type: "done", text: "Stopped." });
    }
  }

  send(prompt: string, context: string, provider: AgentProvider, conversationId?: string): void {
    if (this.proc) throw new Error("The agent is still working. Stop it first.");
    if (conversationId) this.conversations[provider.id] = conversationId;
    else delete this.conversations[provider.id];
    const bin = which(provider.executable);
    if (!bin) throw new Error(`${provider.executable} CLI not found on PATH`);

    const args = provider.command({
      message: context ? `[Context] ${context}\n\n${prompt}` : prompt,
      conversationId: this.conversations[provider.id],
      mcpUrl: this.endpoint.url,
      mcpToken: this.endpoint.token,
      systemPrompt: SYSTEM_PROMPT,
    });
    const parse = provider.parser();
    const record = this.recordDir
      ? join(this.recordDir, `${provider.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
      : undefined;

    log(`chat: starting ${provider.id}`);
    this.emit({ type: "status", text: `${provider.id} is working...` });
    const proc = spawn(bin, args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.proc = proc;

    let stderr = "";
    proc.stderr!.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      if (record) appendFileSync(record, line + "\n");
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return;
      }
      try {
        for (const ev of parse(json)) {
          if (ev.type === "conversation") {
            if (this.conversations[provider.id] === ev.id) continue;
            this.conversations[provider.id] = ev.id;
          }
          this.emit(toChatEvent(ev, provider.id));
        }
      } catch (err) {
        log(`chat: bad event: ${String(err)}`);
      }
    });
    proc.on("close", (code) => {
      log(`chat: ${provider.id} finished with code ${code}`);
      if (this.proc !== proc) return; // stopped
      this.proc = undefined;
      if (code === 0) this.emit({ type: "done" });
      else this.emit({ type: "error", text: `${provider.id} exited with code ${code}. ${stderr.trim().split("\n").slice(-3).join(" ")}` });
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.emit({ type: "error", text: err.message });
    });
  }
}
