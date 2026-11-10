#!/usr/bin/env node
// ase: the Aseprite tools from a shell (#30).
//
// Live mode talks to the running Aseprite through a short-lived bridge (the
// extension connects to the newest bridge and returns to the previous one
// when this exits). File mode runs Aseprite headless (`aseprite -b`) on a
// file and needs no GUI. Headless mode (`--headless`, or
// ASEPRITE_AGENT_MODE=headless) runs state, snapshot, check and timeline on
// files in one long-lived headless Aseprite (headless.ts), never as a fallback.
//
//   ase state [--json]                         document state (live)
//   ase snapshot [--frame N] [--layer L] -o out.png
//   ase check [file.aseprite] [--json]         pixel-art checks (live, or file mode)
//   ase run <script.lua> | -e <code> [--json]  run Lua as one undo step (live)
//   ase timeline [--json]                      the timeline as text (live)
//   ase render <file.aseprite> --sheet out.png [--data out.json] | --gif out.gif
//   ase commands [filter]                      Aseprite's built-in commands (offline)
//   ase --headless snapshot a.aseprite b.aseprite ... -o outdir/   (also state, check, timeline)
//
// --json prints one JSON object. Failures print "✗ <problem>" and
// "Fix: <what to do>" and exit 1; `ase check` also exits 1 when it finds errors.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsepriteLink } from "./aseprite.js";
import { HeadlessLink, headlessRequested, LiveFileError } from "./headless.js";
import { findTool, formatCheck, runTool, toolContext, type AsepriteRequester, type ToolResult } from "./tools.js";
import { VERSION } from "./server.js";

/** For offline commands (ase commands): tools that need Aseprite fail clearly. */
const OFFLINE: AsepriteRequester = {
  request: async (method) => {
    throw new Error(`${method} needs the running Aseprite`);
  },
};

export class CliError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

export interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["frame", "layer", "o", "out", "e", "sheet", "data", "gif", "scale", "aseprite"]);

/** argv (without node and script) -> command, positional args and flags. */
export function parseArgs(argv: string[]): Parsed {
  // --headless may come before the command.
  const headless = argv.includes("--headless");
  const [command = "help", ...rest] = argv.filter((a) => a !== "--headless");
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m || a === "-") {
      positional.push(a);
      continue;
    }
    const [, key, inline] = m;
    if (inline !== undefined) flags[key] = inline;
    else if (VALUE_FLAGS.has(key)) {
      const v = rest[++i];
      if (v === undefined) throw new CliError(`--${key} needs a value`, `Write --${key} <value>.`);
      flags[key] = v;
    } else flags[key] = true;
  }
  if (headless) flags.headless = true;
  return { command, positional, flags };
}

export const USAGE = `ase ${VERSION}: Aseprite from the shell

  ase state [--json]                          document state of the running Aseprite
  ase snapshot [--frame N] [--layer L] -o out.png
  ase check [file.aseprite] [--json]          pixel-art checks (running app, or a file headless)
  ase run <script.lua> | -e <code> [--json]   run Lua in the running app as one undo step
  ase timeline [--json]                       the timeline as text
  ase render <file.aseprite> --sheet out.png [--data out.json] | --gif out.gif
  ase commands [filter]                       Aseprite's built-in commands
  ase --headless state|check|timeline <files...> [--json]
  ase --headless snapshot <files...> [--frame N] [--layer L] -o out.png|outdir/

Live commands need Aseprite open with the Aseprite Agent extension.
File commands run Aseprite headless; set ASEPRITE_BIN if \`aseprite\` is not on PATH.
--headless (or ASEPRITE_AGENT_MODE=headless) runs every file in one headless
Aseprite instead of the live window, and refuses files the live window has open.`;

/** Text of a tool result. */
function textOf(r: ToolResult): string {
  return r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function withAseprite<T>(fn: (link: AsepriteLink) => Promise<T>): Promise<T> {
  const link = new AsepriteLink();
  link.sessionExtra = { version: VERSION, mode: "cli" };
  await link.start(0);
  try {
    if (!(await link.waitForConnection(Number(process.env.ASE_CONNECT_MS ?? 10_000)))) {
      throw new CliError("Aseprite is not connected",
        "Open Aseprite with the Aseprite Agent extension installed (File > Scripts > AI Agent > Connect).");
    }
    return await fn(link);
  } finally {
    link.stop();
  }
}

async function tool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return withAseprite((link) => runTool(findTool(name)!, input, toolContext(link)));
}

// ---------------------------------------------------------------------------
// File mode
// ---------------------------------------------------------------------------

/** The Aseprite executable: ASEPRITE_BIN, this repository's build, `aseprite` on PATH, or the macOS app. */
export function asepriteBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ASEPRITE_BIN,
    process.env.ASEPRITE,
    join(here, "../../../build/bin/aseprite"),
    "/Applications/Aseprite.app/Contents/MacOS/aseprite",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync("/bin/sh", ["-c", "command -v aseprite"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new CliError("Aseprite executable not found", "Set ASEPRITE_BIN to the aseprite binary, or put `aseprite` on PATH.");
}

/** The extension folder (document handlers) for headless scripts. */
function extensionDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [join(here, "../extension"), join(here, "../../extension")].find((d) => existsSync(join(d, "document_handlers.lua")));
  if (!dir) throw new CliError("The extension files are missing", "Run ase from the repository, or reinstall the package.");
  return dir;
}

function runHeadless(args: string[]): string {
  const r = spawnSync(asepriteBin(), ["-b", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new CliError(`Aseprite failed: ${(r.stderr || r.stdout).trim()}`, "Check the file path and arguments.");
  return r.stdout;
}

function needFile(file: string | undefined): string {
  if (!file) throw new CliError("No file given", "Pass a .aseprite (or image) file.");
  const path = resolve(file);
  if (!existsSync(path)) throw new CliError(`File not found: ${file}`, "Check the path.");
  return path;
}

const CHECK_SCRIPT = `
local P = (function() local f = assert(io.open(app.fs.joinPath(app.params.ext, "protocol.json"))); local p = json.decode(f:read("a")); f:close(); return p end)()
local H = dofile(app.fs.joinPath(app.params.ext, "document_handlers.lua")).new{ chunkDir = app.params.ext, protocol = P }
print("ASE_JSON " .. json.encode(H.call("check", {})))
`;

function checkFile(file: string): any {
  const dir = mkdtempSync(join(tmpdir(), "ase-"));
  const script = join(dir, "check.lua");
  writeFileSync(script, CHECK_SCRIPT);
  const out = runHeadless([needFile(file), "--script-param", `ext=${extensionDir()}`, "--script", script]);
  const line = out.split("\n").find((l) => l.startsWith("ASE_JSON "));
  if (!line) throw new CliError("The check script printed nothing", "Run with ASEPRITE_BIN pointing at this fork's build.");
  return JSON.parse(line.slice("ASE_JSON ".length));
}

// ---------------------------------------------------------------------------
// Headless mode (#85): every file in one long-lived runner
// ---------------------------------------------------------------------------

const HEADLESS_COMMANDS = new Set(["state", "snapshot", "check", "timeline"]);

/** Where snapshot i of n goes: -o itself for one file not ending in "/", else <dir>/<name>.png. */
export function snapshotTarget(out: string, file: string, count: number): string {
  const isDir = out.endsWith("/") || (existsSync(out) && !extname(out)) || count > 1;
  return isDir ? join(out, `${basename(file, extname(file))}.png`) : out;
}

/** Headless mode; liveFiles replaces asking the live bridge (the benchmark's fresh temp files). */
export async function runHeadlessMode(p: Parsed, opts: { liveFiles?: () => Promise<string[]> } = {}): Promise<Output> {
  const f = p.flags;
  if (!HEADLESS_COMMANDS.has(p.command)) {
    throw new CliError(`${p.command} has no headless mode`, `Headless runs ${[...HEADLESS_COMMANDS].join(", ")}; drop --headless (and ASEPRITE_AGENT_MODE).`);
  }
  if (p.positional.length === 0) throw new CliError("No files given", "Headless mode works on files: pass one or more .aseprite files.");
  const files = p.positional.map(needFile);
  const out = (f.o ?? f.out) as string | undefined;
  if (p.command === "snapshot" && !out) throw new CliError("No output", "Add -o out.png (one file) or -o outdir/.");
  if (out && p.command === "snapshot" && snapshotTarget(out, files[0], files.length) !== out) mkdirSync(out, { recursive: true });

  const link = new HeadlessLink({ bin: asepriteBin(), extensionDir: extensionDir(), liveFiles: opts.liveFiles });
  await link.start();
  const ctx = toolContext(link);
  const results: { file: string; [k: string]: unknown }[] = [];
  let errors = 0;
  try {
    for (const file of files) {
      try {
        await link.open(file);
      } catch (e) {
        if (e instanceof LiveFileError) throw new CliError(e.message, "Close it in Aseprite first, or work on it live (without --headless).");
        throw new CliError(e instanceof Error ? e.message : String(e), "Check the file, and that the live Aseprite's bridge is current.");
      }
      if (p.command === "snapshot") {
        const r = await runTool(findTool("snapshot")!, {
          frame: f.frame ? Number(f.frame) : undefined,
          layer: f.layer as string | undefined,
          scale: f.scale ? Number(f.scale) : undefined,
        }, ctx);
        if (r.isError) throw new CliError(`${file}: ${textOf(r)}`, "Check --frame and --layer.");
        const img = r.content.find((c) => c.type === "image") as { data: string };
        const target = resolve(snapshotTarget(out!, file, files.length));
        writeFileSync(target, Buffer.from(img.data, "base64"));
        results.push({ file, out: target, info: textOf(r) });
      } else if (p.command === "check") {
        const r = (await link.request("check", {})).result;
        errors += r.errors > 0 ? 1 : 0;
        results.push({ file, ...r });
      } else if (p.command === "state") {
        results.push({ file, state: JSON.parse(textOf(await runTool(findTool("get_state")!, {}, ctx))) });
      } else {
        results.push({ file, text: textOf(await runTool(findTool("get_timeline_text")!, {}, ctx)) });
      }
      await link.close(file);
    }
  } finally {
    await link.stop();
  }
  const text = results.map((r) => {
    if (p.command === "snapshot") return `Saved ${r.out} (${r.info})`;
    if (p.command === "check") return `${r.file}\n${formatCheck(r)}`;
    if (p.command === "state") return `${r.file}\n${JSON.stringify(r.state, null, 2)}`;
    return `${r.file}\n${String(r.text).trimEnd()}`;
  }).join("\n");
  return { json: { ok: true, headless: true, files: results }, text, exitCode: errors > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface Output {
  json: unknown;
  text: string;
  /** Non-zero for results that should fail a script, e.g. check errors. */
  exitCode?: number;
}

export async function run(p: Parsed): Promise<Output> {
  const f = p.flags;
  if (headlessRequested(f.headless) && !["help", "--help", "-h", "version", "--version", "commands"].includes(p.command)) {
    return runHeadlessMode(p);
  }
  switch (p.command) {
    case "state": {
      const r = await tool("get_state", {});
      const t = textOf(r);
      return { json: JSON.parse(t), text: t };
    }
    case "snapshot": {
      const out = (f.o ?? f.out) as string | undefined;
      if (!out) throw new CliError("No output file", "Add -o out.png.");
      const r = await tool("snapshot", {
        frame: f.frame ? Number(f.frame) : undefined,
        layer: f.layer as string | undefined,
        scale: f.scale ? Number(f.scale) : undefined,
      });
      if (r.isError) throw new CliError(textOf(r), "Open a sprite in Aseprite.");
      const img = r.content.find((c) => c.type === "image") as { data: string } | undefined;
      writeFileSync(out, Buffer.from(img!.data, "base64"));
      return { json: { ok: true, file: resolve(out), info: textOf(r) }, text: `Saved ${out} (${textOf(r)})` };
    }
    case "check": {
      if (p.positional[0]) {
        const result = checkFile(p.positional[0]);
        return { json: result, text: formatCheck(result), exitCode: result.errors > 0 ? 1 : 0 };
      }
      const r = await withAseprite(async (link) => (await link.request("check", {})).result);
      return { json: r, text: formatCheck(r), exitCode: r.errors > 0 ? 1 : 0 };
    }
    case "run": {
      const code = (f.e as string | undefined) ?? (p.positional[0] ? readFileSync(needFile(p.positional[0]), "utf8") : undefined);
      if (!code) throw new CliError("No Lua given", "Pass a script file or -e '<code>'.");
      const result = await withAseprite(async (link) => (await link.request("execute_lua", { code, label: "ase run" }, 120_000)).result);
      if (!result.ok) throw new CliError(`Lua error: ${result.error}`, result.rolledBack ? "Nothing changed (rolled back). Fix the code." : "Fix the code.");
      const value = result.value === undefined ? "OK" : JSON.stringify(result.value, null, 2);
      return { json: result, text: [...(result.output ?? []), value].join("\n") };
    }
    case "timeline": {
      const r = await tool("get_timeline_text", {});
      return { json: { text: textOf(r) }, text: textOf(r).trimEnd() };
    }
    case "render": {
      const file = needFile(p.positional[0]);
      if (f.sheet) {
        const args = [file, "--sheet", resolve(f.sheet as string)];
        if (f.data) args.push("--data", resolve(f.data as string), "--format", "json-array");
        runHeadless(args);
        return { json: { ok: true, sheet: resolve(f.sheet as string), data: f.data ? resolve(f.data as string) : undefined }, text: `Saved ${f.sheet}` };
      }
      if (f.gif) {
        runHeadless([file, "--save-as", resolve(f.gif as string)]);
        return { json: { ok: true, gif: resolve(f.gif as string) }, text: `Saved ${f.gif}` };
      }
      throw new CliError("Nothing to render", "Add --sheet out.png or --gif out.gif.");
    }
    case "commands": {
      const r = await runTool(findTool("list_commands")!, { filter: p.positional[0] }, toolContext(OFFLINE));
      return { json: { text: textOf(r) }, text: textOf(r) };
    }
    case "help":
    case "--help":
    case "-h":
      return { json: { usage: USAGE }, text: USAGE };
    case "version":
    case "--version":
      return { json: { version: VERSION }, text: VERSION };
    default:
      throw new CliError(`Unknown command: ${p.command}`, "Run `ase help` for the list of commands.");
  }
}

async function main() {
  process.env.ASEPRITE_AGENT_QUIET = "1";
  let json = false;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    json = !!parsed.flags.json;
    const out = await run(parsed);
    console.log(json ? JSON.stringify(out.json, null, 2) : out.text);
    process.exit(out.exitCode ?? 0);
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError(err instanceof Error ? err.message : String(err), "Run `ase help`.");
    if (json) console.log(JSON.stringify({ ok: false, error: e.message, fix: e.fix }, null, 2));
    else console.error(`✗ ${e.message}\nFix: ${e.fix}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
