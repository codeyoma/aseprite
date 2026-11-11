// The chat's project folder (#93): a chat works in its sprite's folder when
// the sprite is saved (else the shared workspace), with a short AGENTS.md
// created there on first use, like HyperFrames' init. A conversation keeps
// the folder it started in, since agents keep their sessions per folder
// (Claude's session/load fails in another one).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "./aseprite.js";

/** One approved style memory entry, as the panel sends it. */
export interface MemoryEntry {
  topic: string;
  text: string;
}

export const MEMORY_START = "<!-- aseprite-agent:style-memory:start -->";
export const MEMORY_END = "<!-- aseprite-agent:style-memory:end -->";

/** The style memory section's lines (between the markers). */
export function memoryLines(memory: MemoryEntry[] = []): string {
  if (!memory.length) return "(none yet: the agent proposes entries with remember_style, you approve them in the chat)";
  return memory.map((m) => `- ${m.topic}: ${m.text.replace(/\s+/g, " ").trim()}`).join("\n");
}

/** A new project's AGENTS.md: what the folder is and where the style memory lives. */
export function agentsMd(dir: string, memory: MemoryEntry[] = []): string {
  return `# ${basename(dir)}: an Aseprite project

This folder holds Aseprite sprites (.aseprite). The AI Agent panel in Aseprite starts its agent here; draw and edit through the aseprite MCP tools, and keep files you make (exports, references, notes) in this folder.

Style memory: the palette roles, outline rule, pixel scale and notes the user approved. Each sprite keeps its entries (sprite property aseprite-agent "style.memory") and every chat message shows them in the State block; the list below mirrors the last sprite the chat worked on. Propose new entries with remember_style.

## Style memory
${MEMORY_START}
${memoryLines(memory)}
${MEMORY_END}
`;
}

/** The text with its style memory section replaced; undefined when it has no markers (a file the user wrote). */
export function withMemory(text: string, memory: MemoryEntry[] = []): string | undefined {
  const a = text.indexOf(MEMORY_START), b = text.indexOf(MEMORY_END);
  if (a < 0 || b < a) return undefined;
  return text.slice(0, a + MEMORY_START.length) + "\n" + memoryLines(memory) + "\n" + text.slice(b);
}

/** Folders a chat never starts in, even with a sprite saved there. */
function tooBroad(dir: string): boolean {
  const d = resolve(dir);
  return d === resolve(homedir()) || d === dirname(d);
}

/**
 * The project folder for a sprite file (its folder), or undefined for an unsaved sprite, a folder that is gone, or
 * one too broad to call a project (the home folder, a drive root).
 */
export function projectDirOf(spriteFile?: string): string | undefined {
  if (!spriteFile || !isAbsolute(spriteFile)) return undefined;
  const dir = dirname(spriteFile);
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return tooBroad(dir) ? undefined : dir;
}

/**
 * Creates the project's AGENTS.md on first use and keeps its style memory section current. A file without the
 * markers is the user's and is left alone. Returns what happened.
 */
export function ensureProject(dir: string, memory?: MemoryEntry[]): "created" | "updated" | "kept" | "failed" {
  const file = join(dir, "AGENTS.md");
  try {
    if (!existsSync(file)) {
      writeFileSync(file, agentsMd(dir, memory));
      return "created";
    }
    if (!memory) return "kept";
    const old = readFileSync(file, "utf8");
    const next = withMemory(old, memory);
    if (next === undefined || next === old) return "kept";
    writeFileSync(file, next);
    return "updated";
  } catch (err) {
    log(`project: could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/**
 * Which folder each conversation started in, kept in a JSON file so it survives bridge restarts. A conversation
 * missing from it started before #93, in the shared workspace.
 */
export class ConversationDirs {
  private dirs: Record<string, string> = {};

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data && typeof data === "object") this.dirs = data;
    } catch {
      // No file yet.
    }
  }

  get(id?: string): string | undefined {
    return id ? this.dirs[id] : undefined;
  }

  set(id: string, dir: string): void {
    if (this.dirs[id] === dir) return;
    this.dirs[id] = dir;
    // Keep the newest 500.
    const keys = Object.keys(this.dirs);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete this.dirs[k];
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.dirs, null, 1));
    } catch (err) {
      log(`project: could not save ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The folder a turn runs in: a known conversation's own folder (the shared workspace when it predates #93), else the
 * project folder of the sprite, else the shared workspace.
 */
export function turnDir(opts: { conversationId?: string; dirs: ConversationDirs; spriteFile?: string; workspace: string }): {
  cwd: string;
  project?: string;
} {
  if (opts.conversationId) {
    const known = opts.dirs.get(opts.conversationId);
    const cwd = known && existsSync(known) ? known : opts.workspace;
    return { cwd, project: cwd === opts.workspace ? undefined : cwd };
  }
  const project = projectDirOf(opts.spriteFile);
  return { cwd: project ?? opts.workspace, project };
}
