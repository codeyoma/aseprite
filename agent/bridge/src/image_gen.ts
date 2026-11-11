// The image generator (#102): a rough image from a prompt, made by Codex's built-in image generation through the
// user's Codex login, for the concept workflow to turn into reference frames and a pixel draft. A generation takes a
// minute or more, longer than an agent waits for one tool call, so it runs as a job: generate_image starts it and
// waits a while, and a later call with the job id waits again.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { decodePng } from "./image.js";
import { agentCodexHome } from "./providers/agent_home.js";
import { which } from "./platform.js";
import { sessionDir } from "./session.js";

export type Aspect = "square" | "portrait" | "landscape";

export interface GeneratedImage {
  path: string;
  width: number;
  height: number;
}

/** Makes one image for a prompt; rejects with a message for the agent. */
export interface ImageGenerator {
  generate(prompt: string, aspect: Aspect, signal: AbortSignal): Promise<GeneratedImage>;
}

/** The instruction for Codex: one image with its built-in tool, nothing else, and the path back as JSON. */
export function codexInstruction(prompt: string, aspect: Aspect): string {
  const size = aspect === "portrait" ? "1024x1536" : aspect === "landscape" ? "1536x1024" : "1024x1024";
  return [
    "Use your built-in image generation tool to make exactly one image, at " + size + ".",
    "Don't run shell commands, read or write files, or use any other tool.",
    "Image: " + prompt,
    'Then reply only with JSON: {"path": "<the absolute path of the generated PNG>"}.',
  ].join("\n");
}

const SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

/** The newest PNG under dir changed after `since` (ms), or undefined. */
export function newestPng(dir: string, since: number): string | undefined {
  let best: { path: string; t: number } | undefined;
  const walk = (d: string, depth: number) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name.toLowerCase().endsWith(".png") && st.mtimeMs >= since && (!best || st.mtimeMs > best.t)) best = { path: p, t: st.mtimeMs };
    }
  };
  walk(dir, 0);
  return best?.path;
}

/** True when `p` is inside `dir` (after resolving links). */
export function inside(dir: string, p: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(p));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Codex in the agent's own Codex home (the user's login, none of their MCP servers or skills), in an empty folder
 * with a read-only sandbox, so it sees nothing of the user's files and has no Aseprite tools. The PNG must be one it
 * wrote under that home's generated_images during this job; it is copied to the agent's generated folder.
 */
export class CodexImageGenerator implements ImageGenerator {
  constructor(
    private readonly outDir = join(sessionDir, "generated"),
    private readonly home = () => agentCodexHome(),
  ) {}

  async generate(prompt: string, aspect: Aspect, signal: AbortSignal): Promise<GeneratedImage> {
    const bin = which("codex");
    if (!bin) throw new Error("The image generator needs the Codex CLI (codex), signed in; it isn't on PATH.");
    const home = this.home();
    const work = mkdtempSync(join(tmpdir(), "aseprite-imagegen-"));
    const schema = join(work, "schema.json");
    writeFileSync(schema, JSON.stringify(SCHEMA));
    const started = Date.now() - 1000;
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const args = ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-C", work, "--output-schema", schema, codexInstruction(prompt, aspect)];
        const proc = spawn(bin, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: home } });
        let last = "", err = "", buf = "";
        proc.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              const ev = JSON.parse(line);
              if (ev?.type === "item.completed" && ev.item?.type === "agent_message") last = String(ev.item.text ?? "");
              if (ev?.type === "turn.failed" || ev?.type === "error") err = String(ev.error?.message ?? ev.message ?? "Codex failed");
            } catch { /* not JSON */ }
          }
        });
        proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
        const abort = () => proc.kill();
        signal.addEventListener("abort", abort, { once: true });
        proc.on("error", reject);
        proc.on("close", (code) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(new Error("The image generation was cancelled."));
          else if (code === 0) resolve(last);
          else reject(new Error(`Codex image generation failed (exit ${code}): ${err.trim().split("\n").pop() ?? ""}`));
        });
      });
      const generated = join(home, "generated_images");
      let path: string | undefined;
      try {
        const p = JSON.parse(reply)?.path;
        if (typeof p === "string" && existsSync(p) && inside(generated, p) && statSync(p).mtimeMs >= started) path = p;
      } catch { /* not JSON: fall back to the newest image */ }
      path ??= newestPng(generated, started);
      if (!path) throw new Error("Codex made no image (is image generation available on this Codex plan?). Reply: " + reply.slice(0, 200));
      const img = decodePng(readFileSync(path));
      mkdirSync(this.outDir, { recursive: true });
      const out = join(this.outDir, `image-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      copyFileSync(path, out);
      return { path: out, width: img.width, height: img.height };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

interface Job {
  id: string;
  prompt: string;
  started: number;
  controller: AbortController;
  done: Promise<void>;
  result?: GeneratedImage;
  error?: string;
}

/** Generation jobs, one at a time; finished ones are kept for an hour so a late wait still finds them. */
export class ImageJobs {
  private jobs = new Map<string, Job>();
  private next = 1;
  constructor(private readonly generator: ImageGenerator, private readonly maxMs = 5 * 60_000) {}

  running(): Job | undefined {
    for (const j of this.jobs.values()) if (!j.result && !j.error) return j;
    return undefined;
  }

  start(prompt: string, aspect: Aspect): Job {
    if (this.running()) throw new Error("An image is already being generated; wait for it with its job id.");
    const controller = new AbortController();
    const id = `img-${this.next++}`;
    const timer = setTimeout(() => controller.abort(), this.maxMs);
    const job: Job = { id, prompt, started: Date.now(), controller, done: Promise.resolve() };
    job.done = this.generator.generate(prompt, aspect, controller.signal).then(
      (r) => { job.result = r; },
      (e) => { job.error = (e as Error).message; },
    ).finally(() => clearTimeout(timer));
    this.jobs.set(id, job);
    for (const [k, j] of this.jobs) if (Date.now() - j.started > 60 * 60_000) this.jobs.delete(k);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Waits up to ms for a job; true when it finished. */
  async wait(job: Job, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      job.done.then(() => true),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); }),
    ]);
    clearTimeout(timer);
    return finished;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.result || j.error) return false;
    j.controller.abort();
    return true;
  }
}
