// Saved Commands (#26): Lua operations the agent wrote and the user wants
// to keep, as commands in Aseprite's menu. Stored in
// ~/.aseprite-agent/commands (ASEPRITE_AGENT_COMMANDS overrides it):
//
//   commands.json   { "commands": [ { name, title, description, params, created, updated, enabled } ] }
//   <name>.lua      the body; it runs as one undo step with `args` (a table) in scope
//
// The folder is a git repository: each save, delete, enable/disable and
// revert is a commit, so any version can be restored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir } from "./session.js";

export interface CommandParam {
  name: string;
  description?: string;
  default?: unknown;
}

export interface SavedCommand {
  name: string;
  title: string;
  description: string;
  params: CommandParam[];
  created: string;
  updated: string;
  enabled: boolean;
}

export const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function commandsDir(): string {
  return process.env.ASEPRITE_AGENT_COMMANDS ?? join(sessionDir, "commands");
}

export class SavedCommands {
  constructor(readonly dir = commandsDir(), private readonly now = () => new Date().toISOString()) {}

  private get index() {
    return join(this.dir, "commands.json");
  }

  private git(...args: string[]): { ok: boolean; out: string } {
    const r = spawnSync("git", args, { cwd: this.dir, encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  }

  /** Creates the folder and its git repository on first use. */
  private ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, ".git"))) {
      this.git("init", "-q");
      // Files come back from history exactly as saved (Windows' core.autocrlf would add CR).
      this.git("config", "core.autocrlf", "false");
      this.git("config", "user.name", "Aseprite Agent");
      this.git("config", "user.email", "agent@localhost");
    }
    if (!existsSync(this.index)) writeFileSync(this.index, JSON.stringify({ commands: [] }, null, 2) + "\n");
  }

  private commit(message: string): void {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
  }

  list(): SavedCommand[] {
    try {
      return (JSON.parse(readFileSync(this.index, "utf8")).commands ?? []) as SavedCommand[];
    } catch {
      return [];
    }
  }

  private write(list: SavedCommand[]): void {
    writeFileSync(this.index, JSON.stringify({ commands: list }, null, 2) + "\n");
  }

  get(name: string): SavedCommand | undefined {
    return this.list().find((c) => c.name === name);
  }

  code(name: string): string {
    return readFileSync(join(this.dir, `${name}.lua`), "utf8");
  }

  /** Saves (creates or updates) a command and commits it. */
  save(input: { name: string; title: string; description: string; code: string; params?: CommandParam[] }): SavedCommand {
    if (!COMMAND_NAME.test(input.name)) {
      throw new Error("Command names are lowercase letters, digits and dashes, starting with a letter (e.g. outline-dark)");
    }
    this.ensure();
    const list = this.list();
    const old = list.find((c) => c.name === input.name);
    const at = this.now();
    const cmd: SavedCommand = {
      name: input.name,
      title: input.title,
      description: input.description,
      params: input.params ?? [],
      created: old?.created ?? at,
      updated: at,
      enabled: old?.enabled ?? true,
    };
    this.write([...list.filter((c) => c.name !== input.name), cmd].sort((a, b) => a.name.localeCompare(b.name)));
    writeFileSync(join(this.dir, `${input.name}.lua`), input.code.endsWith("\n") ? input.code : input.code + "\n");
    this.commit(`${old ? "Update" : "Add"} ${input.name}: ${input.description}`);
    return cmd;
  }

  delete(name: string): boolean {
    if (!this.get(name)) return false;
    this.write(this.list().filter((c) => c.name !== name));
    try {
      unlinkSync(join(this.dir, `${name}.lua`));
    } catch {
      // already gone
    }
    this.commit(`Delete ${name}`);
    return true;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const list = this.list();
    const cmd = list.find((c) => c.name === name);
    if (!cmd) return false;
    cmd.enabled = enabled;
    this.write(list);
    this.commit(`${enabled ? "Enable" : "Disable"} ${name}`);
    return true;
  }

  /** Versions of a command's code, newest first: { rev, date, message }. */
  history(name: string): { rev: string; date: string; message: string }[] {
    const r = this.git("log", "--format=%h%x09%cI%x09%s", "--", `${name}.lua`);
    if (!r.ok || !r.out) return [];
    return r.out.split("\n").map((l) => {
      const [rev, date, message] = l.split("\t");
      return { rev, date, message };
    });
  }

  /** Restores the command's code from `rev` (default: the version before the current one) as a new commit. */
  revert(name: string, rev?: string): string {
    const versions = this.history(name);
    const target = rev ?? versions[1]?.rev;
    if (!target) throw new Error(`${name} has no earlier version`);
    const r = this.git("checkout", target, "--", `${name}.lua`);
    if (!r.ok) throw new Error(`Could not restore ${name} from ${target}: ${r.out}`);
    const list = this.list();
    const cmd = list.find((c) => c.name === name);
    if (cmd) {
      cmd.updated = this.now();
      this.write(list);
    }
    this.commit(`Revert ${name} to ${target}`);
    return target;
  }
}

/** Saved commands for the panel (#26): versions, revert, enable/disable. */
export function commandMethods(store = new SavedCommands()): Record<string, (params: any) => unknown> {
  return {
    "commands.history": (p: { name: string }) => ({ versions: store.history(String(p.name)) }),
    "commands.revert": (p: { name: string; rev?: string }) => ({ restored: store.revert(String(p.name), p.rev) }),
    "commands.setEnabled": (p: { name: string; enabled: boolean }) => ({ ok: store.setEnabled(String(p.name), !!p.enabled) }),
  };
}
