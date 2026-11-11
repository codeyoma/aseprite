// The two Aseprite instances on one machine, kept apart (see docs/INSTANCES.md):
//
//   stable  the user's: built from the `stable` branch in its own folder, the
//           default Aseprite user folder and agent home (~/.aseprite-agent);
//           its extension is a copy, so dev edits never reach it.
//   dev     the agent's: this checkout's build/bin/aseprite, its own Aseprite
//           user folder and agent home (~/.aseprite-agent-dev); its extension
//           links this checkout's files; tests and benchmarks only use it.
//
// Two environment variables make an instance: ASEPRITE_USER_FOLDER (Aseprite's
// settings, extensions, sessions) and ASEPRITE_AGENT_HOME (the bridge session,
// chats' workspace, attachments). Cross-platform (macOS, Windows, Linux).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IS_WINDOWS = process.platform === "win32";
const exe = (p) => (IS_WINDOWS ? `${p}.exe` : p);

/** Aseprite's default user folder on this platform (what it uses without ASEPRITE_USER_FOLDER). */
export function defaultUserFolder() {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Aseprite");
  if (IS_WINDOWS) return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Aseprite");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aseprite");
}

export const DEV = {
  name: "dev",
  home: process.env.ASEPRITE_AGENT_DEV_HOME ?? join(homedir(), ".aseprite-agent-dev"),
  get userFolder() { return join(this.home, "aseprite"); },
  bin: exe(join(REPO, "build", "bin", "aseprite")),
  extensionSource: join(REPO, "agent", "extension"),
  bridge: join(REPO, "agent", "bridge", "dist", "index.js"),
};

export const STABLE = {
  name: "stable",
  home: join(homedir(), ".aseprite-agent"),
  userFolder: defaultUserFolder(),
  /** Where the stable source (a worktree of this repository on `stable`) and its build live. */
  root: process.env.ASEPRITE_AGENT_STABLE_ROOT ?? join(homedir(), ".aseprite-agent-stable"),
  get src() { return join(this.root, "src"); },
  get buildDir() { return join(this.root, "build"); },
  get bin() { return exe(join(this.buildDir, "bin", "aseprite")); },
  get extensionSource() { return join(this.src, "agent", "extension"); },
  get bridge() { return join(this.src, "agent", "bridge", "dist", "index.js"); },
};

/** The environment that makes an instance (only dev sets the user folder; stable uses Aseprite's default). */
export function instanceEnv(inst) {
  const env = { ASEPRITE_AGENT_HOME: inst.home };
  if (inst === DEV) env.ASEPRITE_USER_FOLDER = inst.userFolder;
  return env;
}

/**
 * Installs the extension into an instance's user folder: a real folder with one entry per .lua/.json file (Aseprite
 * skips a symlinked extension folder). link: symlinks to the source (dev, so edits apply on restart), else copies
 * (stable). Removes files the source no longer has. Windows always copies (file symlinks need admin rights).
 */
export function installExtension(inst, { link = inst === DEV } = {}) {
  const dest = join(inst.userFolder, "extensions", "aseprite-agent");
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(inst.extensionSource).filter((f) => /\.(lua|json)$/.test(f) && f !== "__pref.lua");
  for (const f of files) {
    const to = join(dest, f), from = join(inst.extensionSource, f);
    if (existsSync(to) || isLink(to)) unlinkSync(to);
    if (link && !IS_WINDOWS) symlinkSync(from, to);
    else copyFileSync(from, to);
  }
  for (const f of readdirSync(dest)) {
    if (/\.(lua|json)$/.test(f) && f !== "__pref.lua" && !files.includes(f)) rmSync(join(dest, f), { force: true });
  }
  return { dest, files: files.length };
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const pidFile = (inst) => join(inst.home, "aseprite.pid");

/** Starts an instance's Aseprite detached, with its environment; remembers its pid. */
export function launch(inst, args = []) {
  if (!existsSync(inst.bin)) throw new Error(`No Aseprite at ${inst.bin}`);
  mkdirSync(inst.home, { recursive: true });
  if (inst === DEV) mkdirSync(inst.userFolder, { recursive: true });
  const child = spawn(inst.bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...instanceEnv(inst) } });
  child.unref();
  writeFileSync(pidFile(inst), String(child.pid));
  return child.pid;
}

/** Stops the Aseprite this launcher started for the instance (never any other Aseprite). Returns whether one was running. */
export function stop(inst) {
  const file = pidFile(inst);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, "utf8"));
  rmSync(file, { force: true });
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** Whether the instance's Aseprite (started by this launcher) is running. */
export function running(inst) {
  const file = pidFile(inst);
  if (!existsSync(file)) return false;
  try {
    process.kill(Number(readFileSync(file, "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}
