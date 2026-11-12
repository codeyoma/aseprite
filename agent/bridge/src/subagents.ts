// Parallel sub-agents (#33): spawn_agents splits a task into sub-tasks, each
// scoped to frames (and optionally layers), and runs up to `parallel` ACP
// agents at once. Each sub-agent gets its own MCP endpoint
// (/mcp/scope/<id>) whose requests carry the scope, so the extension can
// refuse edits outside it; edits still go through the one extension
// connection, one at a time.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AcpRunner } from "./acp.js";
import type { ImageBlock } from "./attachments.js";
import type { ChatEvent } from "./chat.js";
import { CRITIC_PROMPT } from "./critic.js";
import type { CriticRunner, CriticSession, SubAgentRunner } from "./tool.js";
import { toChatEvent } from "./chat.js";
import type { AgentProvider } from "./providers/agent_provider.js";
import { providerFor } from "./providers/index.js";
import { sessionDir } from "./session.js";

export interface Scope {
  frames: string | number | number[];
  layers?: string[];
  label?: string;
}

export interface SubTask {
  prompt: string;
  frames: string | number | number[];
  layers?: string[];
  label?: string;
}

export interface SubResult {
  label: string;
  ok: boolean;
  text: string;
  seconds: number;
}

// Scopes by endpoint id, read by the HTTP endpoint (http.ts).
const scopes = new Map<string, Scope>();
export function scopeFor(id: string): Scope | undefined {
  return scopes.get(id);
}
/** Test hook: register a scope without starting an agent. */
export function __setScopeForTest(id: string, scope: Scope): void {
  scopes.set(id, scope);
}

export const SUBAGENT_PROMPT = `You are a sub-agent inside Aseprite, started by another agent to do one part of a larger job.
You may only edit your scope: the frames (and layers, if given) named in the task. Edits outside it are refused and undone, and you can't use undo or redo; fix forward instead. Don't add or remove frames or layers.
Your first message has an <aseprite-state> block with the document (layers with ids, frames, palette); trust it instead of calling get_state. Edit with apply: the whole change as ops (pixel rows, rects and lines on a layer and frame) in one call and one undo step; use execute_lua only for what apply can't express (layerById("L12") returns a layer by id; edit a copy of cel.image and assign it back). Read read_guide("basics") only if you are unsure about the API.
Work quickly: do your frames in as few calls as you can. When done, reply with one sentence on what you changed.`;

export function scopeLabel(t: SubTask): string {
  const frames = Array.isArray(t.frames) ? t.frames.join(",") : String(t.frames);
  return t.label ?? `frames ${frames}${t.layers?.length ? ` · ${t.layers.join(",")}` : ""}`;
}

/** Runs tasks with at most `limit` at once; results keep the task order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export class SubAgents {
  constructor(
    /** criticUrl: the critics' read-only endpoint (#76); without it critics use askUrl. */
    private readonly endpoint: { url: string; token: string; askUrl?: string; criticUrl?: string },
    /** The document's state block, sent with each sub-agent's task. */
    private readonly stateBlock: () => Promise<string>,
    /** The provider of a chat's running turn (sub-agents use the same agent). */
    private readonly providerFor: (chat?: string) => AgentProvider,
    /** Shows sub-agent steps in the chat panel. */
    private readonly emit: (ev: ChatEvent) => void,
  ) {}

  /**
   * This runner for one chat (#90): its sub-agents and critics use that chat's agent, their tool calls run on that
   * chat's sprite, and their steps show in that chat.
   */
  forChat(chat: string): SubAgentRunner & CriticRunner {
    return { run: (tasks, parallel) => this.run(tasks, parallel, chat), open: (label) => this.open(label, chat) };
  }

  /** The chat's address on an endpoint URL, and its id on events. */
  private chatUrl(url: string, chat?: string): string {
    return chat ? `${url}${url.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chat)}` : url;
  }
  private send(ev: ChatEvent, chat?: string): void {
    this.emit(chat ? { ...ev, chatId: chat } : ev);
  }

  async run(tasks: SubTask[], parallel = 4, chat?: string): Promise<SubResult[]> {
    const provider = this.providerFor(chat);
    const state = await this.stateBlock().catch(() => "");
    return pool(tasks, parallel, (task) => this.runOne(provider, task, state, chat));
  }

  /**
   * A fresh critic (#76): an agent of the running chat's provider on the critics' read-only endpoint (read tools,
   * no critique, ab_compare or spawn_agents), with the critic prompt and none of the conversation. Each ask is one
   * prompt in the same ACP session, so a retry can say what was wrong with the last reply.
   */
  open(label: string, chat?: string): CriticSession {
    // ASEPRITE_AGENT_CRITIC=claude|codex picks the critic's agent outside a chat turn (live tests over MCP).
    const forced = process.env.ASEPRITE_AGENT_CRITIC;
    const provider = forced ? providerFor(forced) : this.providerFor(chat);
    const url = this.chatUrl(this.endpoint.criticUrl ?? this.endpoint.askUrl ?? this.endpoint.url, chat);
    let texts: string[] = [];
    let failed: string | undefined;
    let conversationId: string | undefined;
    const runner = new AcpRunner(
      provider,
      { url, askUrl: url, token: this.endpoint.token },
      join(sessionDir, "workspace"),
      CRITIC_PROMPT,
      {
        onEvent: (ev) => {
          if (ev.type === "plan" || ev.type === "thinking" || ev.type === "conversation") return;
          if (ev.type === "text") {
            texts.push(ev.text);
            return; // the reply is JSON for the tool, not chat text
          }
          if (ev.type === "error") {
            failed = ev.text;
            this.send({ type: "status", text: `${label}: ${ev.text}` }, chat);
            return;
          }
          this.send({ ...toChatEvent(ev, provider.id), agent: label }, chat);
        },
        onPermission: async () => ({ outcome: "cancelled" }),
      },
    );
    this.send({ type: "status", text: `${label} started` }, chat);
    return {
      ask: async (message: string, images: ImageBlock[] = []) => {
        texts = [];
        failed = undefined;
        // Ask mode: the read-only endpoint and no built-in tools (Claude) or a read-only sandbox (Codex).
        const r = await runner.prompt(message, conversationId, images, "ask");
        conversationId = r.conversationId;
        if (failed) throw new Error(`${label} failed: ${failed}`);
        if (r.stopReason !== "end_turn") throw new Error(`${label} stopped early (${r.stopReason})`);
        return texts.join("\n").trim();
      },
      close: () => runner.dispose(),
    };
  }

  private async runOne(provider: AgentProvider, task: SubTask, state: string, chat?: string): Promise<SubResult> {
    const label = scopeLabel(task);
    const id = randomBytes(9).toString("hex");
    scopes.set(id, { frames: task.frames, layers: task.layers, label });
    const started = Date.now();
    const texts: string[] = [];
    let failed: string | undefined;
    const runner = new AcpRunner(
      provider,
      { url: this.chatUrl(`${this.endpoint.url}/scope/${id}`, chat), token: this.endpoint.token },
      join(sessionDir, "workspace"),
      SUBAGENT_PROMPT,
      {
        onEvent: (ev) => {
          if (ev.type === "plan" || ev.type === "thinking" || ev.type === "conversation") return;
          if (ev.type === "text") texts.push(ev.text);
          if (ev.type === "error") {
            // Not a chat "error": that would end the lead agent's turn.
            failed = ev.text;
            this.send({ type: "status", text: `Sub-agent ${label}: ${ev.text}` }, chat);
            return;
          }
          this.send({ ...toChatEvent(ev, provider.id), agent: label }, chat);
        },
        // Sub-agents only have the aseprite tools, which need no permission.
        onPermission: async () => ({ outcome: "cancelled" }),
      },
    );
    this.send({ type: "status", text: `Sub-agent ${label} started` }, chat);
    try {
      const scopeText = `Your scope: ${label}${task.layers?.length ? ` (layers ${task.layers.join(", ")})` : ""}.`;
      const { stopReason } = await runner.prompt(`${state ? `${state}\n\n` : ""}${scopeText}\n\n${task.prompt}`);
      if (stopReason !== "end_turn") failed ??= `stopped early (${stopReason})`;
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    } finally {
      runner.dispose();
      scopes.delete(id);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    return { label, ok: !failed, text: failed ? `Failed: ${failed}` : texts.join(" ").trim() || "Done.", seconds };
  }
}

/** spawn_agents result for the lead agent. */
export function formatSubResults(results: SubResult[], seconds: number): string {
  const ok = results.filter((r) => r.ok).length;
  return [
    `${ok} of ${results.length} sub-agents finished in ${seconds}s (run in parallel).`,
    ...results.map((r) => `- ${r.label} (${r.seconds}s)${r.ok ? "" : " FAILED"}: ${r.text}`),
    "Check the result with snapshot, and fix anything a sub-agent missed.",
  ].join("\n");
}
