// Runs an agent CLI (Claude Code or Codex) for the in-app chat panel and
// streams its progress to Aseprite. The CLI uses the user's own login and
// connects back to this bridge over the localhost HTTP MCP endpoint.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AsepriteLink } from "./aseprite.js";
import { log } from "./aseprite.js";
import type { HttpEndpoint } from "./http.js";
import { sessionDir } from "./session.js";

export type Provider = "claude" | "codex";

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
  provider?: Provider;
  sessionId?: string;
}

const SYSTEM_PROMPT = `You are the AI assistant inside Aseprite's "AI Agent" panel. The user is talking to you from inside Aseprite while they draw.
Use the aseprite MCP tools to do what they ask in the open document. Read the guide with read_guide("basics") before your first edit in a conversation.
Each message starts with a [Context] line describing the user's current selection in Aseprite; "this layer", "these frames" and "the selection" refer to it.
After visual changes, check your work with snapshot. Keep replies short: say what you changed in one or two sentences.`;

function which(cmd: string): string | undefined {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : undefined;
}

const DETAIL_LIMIT = 600;

function shorten(text: string): string {
  const t = text.trim();
  return t.length > DETAIL_LIMIT ? t.slice(0, DETAIL_LIMIT) + "…" : t;
}

/** Tool input shown when a tool row is expanded. */
function inputDetail(name: string, input: any): string {
  if (!input) return "";
  if (typeof input.code === "string") return shorten(input.code);
  const { label, ...rest } = input;
  return Object.keys(rest).length ? shorten(JSON.stringify(rest)) : "";
}

/** Text of a tool result (Claude tool_result content or Codex result). */
function resultDetail(content: any): string {
  if (typeof content === "string") return shorten(content);
  const parts = Array.isArray(content) ? content : (content?.content ?? []);
  const texts = parts.filter((c: any) => c?.type === "text").map((c: any) => c.text);
  const images = parts.filter((c: any) => c?.type === "image").length;
  return shorten([...texts, images ? `(${images} image${images > 1 ? "s" : ""})` : ""].filter(Boolean).join("\n"));
}

function toolKind(name: string): "edit" | "read" {
  const short = name.replace(/^mcp__aseprite__/, "");
  return ["execute_lua", "run_command", "undo", "redo"].includes(short) ? "edit" : "read";
}

/** Short description of a tool call for the panel log. */
function describeTool(name: string, input: any): string {
  const short = name.replace(/^mcp__aseprite__/, "");
  switch (short) {
    case "execute_lua": return input?.label ? String(input.label) : "Run Lua";
    case "run_command": return `Run ${input?.name ?? "command"}`;
    case "read_guide": return `Read guide${input?.topic ? `: ${input.topic}` : ""}`;
    case "get_state": return "Read sprite state";
    case "get_context": return "Read selection";
    case "snapshot": return "Look at the sprite";
    case "read_pixels": return "Inspect pixels";
    case "list_commands": return "Look up commands";
    case "undo": return "Undo";
    case "redo": return "Redo";
    default: return short;
  }
}

export class ChatRunner {
  private proc?: ChildProcess;
  // Conversation ids. The panel owns them (they survive bridge restarts) and
  // passes them with each message; we report new ones with a "session" event.
  private sessions: Partial<Record<Provider, string>> = {};
  private readonly cwd = join(sessionDir, "workspace");

  constructor(
    private readonly link: AsepriteLink,
    private readonly endpoint: HttpEndpoint,
  ) {
    mkdirSync(this.cwd, { recursive: true });
  }

  get busy(): boolean {
    return this.proc !== undefined;
  }

  providers(): Record<Provider, boolean> {
    return { claude: which("claude") !== undefined, codex: which("codex") !== undefined };
  }

  private emit(event: ChatEvent): void {
    this.link.notify("chat.event", event as unknown as Record<string, unknown>);
  }

  reset(): void {
    this.stop();
    this.sessions = {};
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = undefined;
      this.emit({ type: "done", text: "Stopped." });
    }
  }

  private setSession(provider: Provider, id: string): void {
    if (this.sessions[provider] === id) return;
    this.sessions[provider] = id;
    this.emit({ type: "session", provider, sessionId: id });
  }

  send(prompt: string, context: string, provider: Provider, sessionId?: string): void {
    if (this.proc) throw new Error("The agent is still working. Stop it first.");
    if (sessionId) this.sessions[provider] = sessionId;
    else delete this.sessions[provider];
    const bin = which(provider);
    if (!bin) throw new Error(`${provider} CLI not found on PATH`);

    const message = context ? `[Context] ${context}\n\n${prompt}` : prompt;
    const { args, parse } = provider === "claude" ? this.claudeArgs(message) : this.codexArgs(message);

    log(`chat: starting ${provider}`);
    this.emit({ type: "status", text: `${provider} is working...` });
    const proc = spawn(bin, args, { cwd: this.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.proc = proc;

    let stderr = "";
    proc.stderr!.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      try {
        parse(ev);
      } catch (err) {
        log(`chat: bad event: ${String(err)}`);
      }
    });
    proc.on("close", (code) => {
      log(`chat: ${provider} finished with code ${code}`);
      if (this.proc !== proc) return; // stopped
      this.proc = undefined;
      if (code === 0) this.emit({ type: "done" });
      else this.emit({ type: "error", text: `${provider} exited with code ${code}. ${stderr.trim().split("\n").slice(-3).join(" ")}` });
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.emit({ type: "error", text: err.message });
    });
  }

  private claudeArgs(message: string) {
    const mcpConfig = {
      mcpServers: {
        aseprite: { type: "http", url: this.endpoint.url, headers: { Authorization: `Bearer ${this.endpoint.token}` } },
      },
    };
    const args = [
      "-p", message,
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", "mcp__aseprite",
      "--permission-mode", "dontAsk",
      "--append-system-prompt", SYSTEM_PROMPT,
    ];
    if (this.sessions.claude) args.push("--resume", this.sessions.claude);

    const pendingTools = new Map<string, string>();
    const parse = (ev: any) => {
      if (ev.session_id) this.setSession("claude", ev.session_id);
      if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) this.emit({ type: "text", text: block.text.trim() });
          else if (block.type === "thinking" && block.thinking?.trim()) this.emit({ type: "thinking", text: block.thinking.trim() });
          else if (block.type === "tool_use") {
            const desc = describeTool(block.name, block.input);
            pendingTools.set(block.id, desc);
            this.emit({ type: "tool", tool: desc, id: block.id, kind: toolKind(block.name), detail: inputDetail(block.name, block.input) });
          }
        }
      } else if (ev.type === "user") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_result") {
            this.emit({
              type: "tool_result",
              tool: pendingTools.get(block.tool_use_id) ?? "tool",
              id: block.tool_use_id,
              ok: !block.is_error,
              detail: resultDetail(block.content),
            });
          }
        }
      } else if (ev.type === "result" && ev.is_error) {
        this.emit({ type: "error", text: String(ev.result ?? ev.subtype ?? "error") });
      }
    };
    return { args, parse };
  }

  private codexArgs(message: string) {
    const config = [
      `mcp_servers.aseprite.url="${this.endpoint.url}"`,
      `mcp_servers.aseprite.http_headers={ Authorization = "Bearer ${this.endpoint.token}" }`,
      `mcp_servers.aseprite.tool_timeout_sec=180`,
      // codex exec cannot ask the user, so pre-approve this server's tools.
      `mcp_servers.aseprite.default_tools_approval_mode="approve"`,
      `developer_instructions=${JSON.stringify(SYSTEM_PROMPT)}`,
    ].flatMap((c) => ["-c", c]);
    const base = ["exec", "--json", "--skip-git-repo-check", ...config];
    const args = this.sessions.codex ? [...base, "resume", this.sessions.codex, message] : [...base, message];

    const parse = (ev: any) => {
      if (ev.type === "thread.started" && ev.thread_id) this.setSession("codex", ev.thread_id);
      const item = ev.item;
      if (ev.type === "item.started" && item?.type === "mcp_tool_call") {
        this.emit({
          type: "tool",
          tool: describeTool(item.tool ?? "tool", item.arguments),
          id: item.id,
          kind: toolKind(item.tool ?? "tool"),
          detail: inputDetail(item.tool ?? "tool", item.arguments),
        });
      } else if (ev.type === "item.completed" && item) {
        if (item.type === "agent_message" && item.text?.trim()) this.emit({ type: "text", text: item.text.trim() });
        else if (item.type === "reasoning" && item.text?.trim()) this.emit({ type: "thinking", text: item.text.trim() });
        else if (item.type === "mcp_tool_call") {
          this.emit({
            type: "tool_result",
            tool: describeTool(item.tool ?? "tool", item.arguments),
            id: item.id,
            ok: item.status !== "failed" && !item.error,
            detail: resultDetail(item.result ?? item.error?.message ?? ""),
          });
        }
      } else if (ev.type === "error" || ev.type === "turn.failed") {
        this.emit({ type: "error", text: String(ev.message ?? ev.error?.message ?? "error") });
      }
    };
    return { args, parse };
  }
}
