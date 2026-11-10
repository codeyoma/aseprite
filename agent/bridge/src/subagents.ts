// Parallel sub-agents (#33): spawn_agents splits a task into sub-tasks, each
// scoped to frames (and optionally layers), and runs up to `parallel` ACP
// agents at once. Each sub-agent gets its own MCP endpoint
// (/mcp/scope/<id>) whose requests carry the scope, so the extension can
// refuse edits outside it; edits still go through the one extension
// connection, one at a time.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AcpRunner } from "./acp.js";
import type { ChatEvent } from "./chat.js";
import { toChatEvent } from "./chat.js";
import type { AgentProvider } from "./providers/agent_provider.js";
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
Your first message has an <aseprite-state> block with the document (layers with ids, frames, palette); trust it instead of calling get_state. Edit with execute_lua (layerById("L12") returns a layer by id; edit a copy of cel.image and assign it back). Read read_guide("basics") only if you are unsure about the API.
Work quickly: do your frames in as few execute_lua calls as you can. When done, reply with one sentence on what you changed.`;

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
    private readonly endpoint: { url: string; token: string },
    /** The document's state block, sent with each sub-agent's task. */
    private readonly stateBlock: () => Promise<string>,
    /** The provider of the running chat turn (sub-agents use the same agent). */
    private readonly providerFor: () => AgentProvider,
    /** Shows sub-agent steps in the chat panel. */
    private readonly emit: (ev: ChatEvent) => void,
  ) {}

  async run(tasks: SubTask[], parallel = 4): Promise<SubResult[]> {
    const provider = this.providerFor();
    const state = await this.stateBlock().catch(() => "");
    return pool(tasks, parallel, (task) => this.runOne(provider, task, state));
  }

  private async runOne(provider: AgentProvider, task: SubTask, state: string): Promise<SubResult> {
    const label = scopeLabel(task);
    const id = randomBytes(9).toString("hex");
    scopes.set(id, { frames: task.frames, layers: task.layers, label });
    const started = Date.now();
    const texts: string[] = [];
    let failed: string | undefined;
    const runner = new AcpRunner(
      provider,
      { url: `${this.endpoint.url}/scope/${id}`, token: this.endpoint.token },
      join(sessionDir, "workspace"),
      SUBAGENT_PROMPT,
      {
        onEvent: (ev) => {
          if (ev.type === "plan" || ev.type === "thinking" || ev.type === "conversation") return;
          if (ev.type === "text") texts.push(ev.text);
          if (ev.type === "error") {
            // Not a chat "error": that would end the lead agent's turn.
            failed = ev.text;
            this.emit({ type: "status", text: `Sub-agent ${label}: ${ev.text}` });
            return;
          }
          this.emit({ ...toChatEvent(ev, provider.id), agent: label });
        },
        // Sub-agents only have the aseprite tools, which need no permission.
        onPermission: async () => ({ outcome: "cancelled" }),
      },
    );
    this.emit({ type: "status", text: `Sub-agent ${label} started` });
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
