#!/usr/bin/env node
// ase: the Aseprite tools from a shell (#30).
//
// Live mode talks to the running Aseprite through a short-lived bridge (the
// extension connects to the newest bridge and returns to the previous one
// when this exits). File mode runs Aseprite headless (`aseprite -b`) on a
// file and needs no GUI.
//
//   ase state [--json]                         document state (live)
//   ase snapshot [--frame N] [--layer L] -o out.png
//   ase check [file.aseprite] [--json]         pixel-art checks (live, or file mode)
//   ase run <script.lua> | -e <code> [--json]  run Lua as one undo step (live)
//   ase timeline [--json]                      the timeline as text (live)
//   ase render <file.aseprite> --sheet out.png [--data out.json] | --gif out.gif
//   ase commands [filter]                      Aseprite's built-in commands (offline)
//
// --json prints one JSON object. Failures print "✗ <problem>" and
// "Fix: <what to do>" and exit 1; `ase check` also exits 1 when it finds errors.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsepriteLink } from "./aseprite.js";
import { findTool, formatCheck, runTool, type ToolResult } from "./tools.js";
import { VERSION } from "./server.js";

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
  const [command = "help", ...rest] = argv;
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

Live commands need Aseprite open with the Aseprite Agent extension.
File commands run Aseprite headless; set ASEPRITE_BIN if \`aseprite\` is not on PATH.`;

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
  return withAseprite((link) => runTool(findTool(name)!, input, link));
}

// ---------------------------------------------------------------------------
// File mode
// ---------------------------------------------------------------------------

/** The Aseprite executable: ASEPRITE_BIN, this repository's build, `aseprite` on PATH, or the macOS app. */
export function asepriteBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ASEPRITE_BIN,
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
      const r = await runTool(findTool("list_commands")!, { filter: p.positional[0] }, { request: async () => ({}) } as any);
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
