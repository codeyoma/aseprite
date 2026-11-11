// What a tool is (the Tool interface, its results, and the seam to
// Aseprite), shared by tools.ts and every *_tools.ts module. Kept apart from
// tools.ts so tool modules can import it without an import cycle.
import type * as z from "zod/v4";
import type { Reply } from "./aseprite.js";
import type { ImageBlock } from "./attachments.js";
import { SavedCommands } from "./saved_commands.js";
import type { SubResult, SubTask } from "./subagents.js";
import type { ImageJobs } from "./image_gen.js";

/** The seam tools use to reach Aseprite: AsepriteLink in the bridge, a fake in tests. */
/** Where a request comes from: a chat turn (and which chat). Sent in the JSON-RPC envelope, not the params. */
export interface RequestRoute {
  origin: "chat";
  chat?: string;
}

export interface AsepriteRequester {
  /**
   * route: a chat turn's request (origin "chat", and the chat's id): the extension runs it on that chat's sprite,
   * whichever tab is active.
   */
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number, route?: RequestRoute): Promise<Reply>;
}

/** Runs spawn_agents' sub-tasks (SubAgents in the bridge, a fake in tests). */
export interface SubAgentRunner {
  run(tasks: SubTask[], parallel?: number): Promise<SubResult[]>;
}

/** One fresh critic agent (#76): each ask is a message in the same session; its reply text comes back. */
export interface CriticSession {
  ask(message: string, images?: ImageBlock[]): Promise<string>;
  close(): void;
}

/** Starts critic agents for critique and ab_compare (SubAgents in the bridge, a fake in tests). */
export interface CriticRunner {
  open(label: string): CriticSession;
}

/**
 * Everything a tool may use, built once per MCP server or CLI call. It is an
 * AsepriteRequester, so tools that only talk to Aseprite take it as one.
 */
export interface ToolContext extends AsepriteRequester {
  /** The Saved Commands store (save_command and friends). */
  commands: SavedCommands;
  /** Sub-agents for spawn_agents; absent where they can't run (CLI, sub-agents themselves). */
  subAgents?: SubAgentRunner;
  /** Fresh critics for critique and ab_compare; absent where they can't run (CLI, sub-agents, critics themselves). */
  critic?: CriticRunner;
  /** Asks the chat's user a yes/no question (#102); absent outside the panel's chats. kind: what is asked, for "don't ask again this turn". */
  ask?: (kind: string, title: string) => Promise<boolean>;
  /** Image generation jobs (#102); absent where there is no generator. */
  images?: ImageJobs;
  /** Shows an event in the calling chat's log (ask_user's question card); absent outside the panel's chats. */
  post?: (ev: { type: string; text?: string; choices?: string[]; topic?: string }) => void;
  /** ab_compare's coin flip; default Math.random (tests pass a seeded one). */
  random?: () => number;
}

/** A ToolContext over `aseprite`; the commands store defaults to the user's folder. */
export function toolContext(
  aseprite: AsepriteRequester,
  opts: { commands?: SavedCommands; subAgents?: SubAgentRunner; critic?: CriticRunner; ask?: ToolContext["ask"]; images?: ImageJobs; post?: ToolContext["post"] } = {},
): ToolContext {
  return {
    post: opts.post,
    ask: opts.ask,
    images: opts.images,
    request: (method, params, timeoutMs) => aseprite.request(method, params, timeoutMs),
    commands: opts.commands ?? new SavedCommands(),
    subAgents: opts.subAgents,
    critic: opts.critic,
  };
}

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<any>;
  /** "edit" changes the document; "read" does not. */
  kind: "edit" | "read";
  /** Short description of a call, shown as a step in the chat panel. */
  label(input: any): string;
  /** Custom behaviour; omitted for tools that forward to Aseprite as-is. */
  run?(input: any, ctx: ToolContext): Promise<ToolResult>;
  /** Timeout for forwarded requests. */
  timeoutMs?: number;
}

export function text(value: unknown): Content {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

export function failure(message: string): ToolResult {
  return { content: [text(message)], isError: true };
}
