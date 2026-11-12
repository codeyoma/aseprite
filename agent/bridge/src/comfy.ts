// ComfyUI handoff (#112): the agent runs the user's ComfyUI workflows and gets their files back as a pose bundle.
// A workflow is an API-format JSON (ComfyUI's "Export (API)") saved with a small manifest that names its inputs
// (a parameter -> a node's input) and its outputs (a node -> a role: image, pose, mask:<part>, depth). Running one:
// upload input images (POST /upload/image), queue it (POST /prompt with our client id), follow the WebSocket (/ws)
// until it finishes or fails, read its outputs (GET /history/<id>) and fetch each file (GET /view) into the session
// folder. The HTTP and WebSocket calls sit behind a transport, so tests replay recorded sessions with a fake.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod/v4";
import { sessionDir } from "./session.js";

/** The default ComfyUI server; ASEPRITE_AGENT_COMFY_URL or comfy.json's url changes it. */
export const COMFY_URL = "http://127.0.0.1:8188";

/** What the client needs from ComfyUI: JSON requests, file upload and download, and the WebSocket's messages. */
export interface ComfyTransport {
  getJson(path: string): Promise<any>;
  postJson(path: string, body: unknown): Promise<any>;
  upload(name: string, bytes: Buffer): Promise<{ name: string; subfolder?: string; type?: string }>;
  download(path: string): Promise<Buffer>;
  /** Messages of the WebSocket for this client id until close() (JSON ones only). */
  listen(clientId: string, onMessage: (msg: any) => void): Promise<{ close(): void }>;
}

/** The transport over HTTP (fetch) and a WebSocket (ws). */
export function httpTransport(url = comfyUrl()): ComfyTransport {
  const base = url.replace(/\/+$/, "");
  const ok = async (r: Response, what: string) => {
    if (!r.ok) throw new Error(`ComfyUI ${what} failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r;
  };
  const reach = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      const m = (e as Error).message;
      if (/fetch failed|ECONNREFUSED|ENOTFOUND/.test(m + String((e as any).cause ?? ""))) throw new Error(`ComfyUI is not running at ${base}: start it, or set its url in ${join(sessionDir, "comfy.json")}.`);
      throw e;
    }
  };
  return {
    getJson: (path) => reach(path, async () => (await ok(await fetch(base + path), `GET ${path}`)).json()),
    postJson: (path, body) => reach(path, async () => (await ok(await fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), `POST ${path}`)).json()),
    upload: (name, bytes) => reach("/upload/image", async () => {
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
      form.append("type", "input");
      form.append("overwrite", "true");
      return (await ok(await fetch(base + "/upload/image", { method: "POST", body: form }), "upload")).json();
    }),
    download: (path) => reach(path, async () => Buffer.from(await (await ok(await fetch(base + path), `GET ${path}`)).arrayBuffer())),
    async listen(clientId, onMessage) {
      const { default: WebSocket } = await import("ws");
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (e) => reject(new Error(`ComfyUI is not running at ${base}: ${e.message}`)));
      });
      ws.on("message", (data, binary) => {
        if (binary) return; // preview images
        try { onMessage(JSON.parse(String(data))); } catch { /* not JSON */ }
      });
      return { close: () => ws.close() };
    },
  };
}

const configSchema = z.object({ url: z.string().optional(), workflows: z.string().optional(), imageWorkflow: z.string().optional() });
export type ComfyConfig = z.infer<typeof configSchema>;

/** comfy.json in the agent home: { url, workflows (a folder), imageWorkflow (the one generate_image runs) }. */
export function comfyConfig(): ComfyConfig {
  const file = join(sessionDir, "comfy.json");
  if (!existsSync(file)) return {};
  try { return configSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return {}; }
}

export const comfyUrl = () => process.env.ASEPRITE_AGENT_COMFY_URL || comfyConfig().url || COMFY_URL;
export const workflowsDir = () => process.env.ASEPRITE_AGENT_COMFY_WORKFLOWS || comfyConfig().workflows || join(sessionDir, "comfy", "workflows");

// ---------------------------------------------------------------------------
// Workflows

const inputRef = z.object({
  node: z.string(),
  input: z.string(),
  /** An image parameter: a local file uploaded first, its uploaded name put in the input. */
  image: z.boolean().optional(),
  description: z.string().optional(),
});
export const manifestSchema = z.object({
  description: z.string().optional(),
  params: z.record(z.string(), inputRef),
  /** Output node id -> role: "image", "pose" (OpenPose keypoints JSON or a skeleton image), "mask:<part>", "depth", "frames". */
  outputs: z.record(z.string(), z.string()),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface Workflow {
  name: string;
  /** The API-format graph: node id -> { class_type, inputs }. */
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  manifest: Manifest;
}

/**
 * The workflows in a folder: <name>.json (API format) beside <name>.manifest.json. A graph saved without its
 * manifest is listed with a problem, so the agent can say what to add.
 */
export function listWorkflows(dir = workflowsDir()): { workflows: Workflow[]; problems: string[] } {
  const workflows: Workflow[] = [], problems: string[] = [];
  if (!existsSync(dir)) return { workflows, problems };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".manifest.json")).sort()) {
    const name = f.slice(0, -5);
    try {
      const graph = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!graph || typeof graph !== "object" || Object.values(graph).some((n: any) => !n || typeof n.class_type !== "string")) {
        problems.push(`${f}: not an API-format workflow (save it with "Export (API)")`);
        continue;
      }
      const mf = join(dir, `${name}.manifest.json`);
      if (!existsSync(mf)) { problems.push(`${f}: no ${name}.manifest.json naming its params and outputs`); continue; }
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(mf, "utf8")));
      for (const [p, r] of Object.entries(manifest.params)) if (!graph[r.node]) problems.push(`${name}: param ${p} names node ${r.node}, which is not in the graph`);
      for (const node of Object.keys(manifest.outputs)) if (!graph[node]) problems.push(`${name}: output node ${node} is not in the graph`);
      workflows.push({ name, graph, manifest });
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { workflows, problems };
}

/** The graph with the parameters set (a copy); throws for an unknown or missing parameter. */
export function bindParams(w: Workflow, values: Record<string, unknown>): Workflow["graph"] {
  const graph = JSON.parse(JSON.stringify(w.graph)) as Workflow["graph"];
  for (const [k, v] of Object.entries(values)) {
    const ref = w.manifest.params[k];
    if (!ref) throw new Error(`Workflow "${w.name}" has no param "${k}" (params: ${Object.keys(w.manifest.params).join(", ") || "none"})`);
    graph[ref.node].inputs[ref.input] = v;
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Running

export interface BundleFile {
  role: string;
  path: string;
  node: string;
}

/** What a run returns: its files by role, in output order. */
export interface PoseBundle {
  workflow: string;
  promptId: string;
  dir: string;
  files: BundleFile[];
}

/**
 * Runs a workflow: uploads image params (local paths), queues the graph, waits for the WebSocket to say it finished
 * (or failed, or was interrupted when `signal` aborts), then downloads every output file of the manifest's output
 * nodes into `outDir/<prompt id>/`.
 */
export async function runWorkflow(t: ComfyTransport, w: Workflow, values: Record<string, unknown>, o: {
  signal?: AbortSignal; outDir?: string; onProgress?: (text: string) => void;
} = {}): Promise<PoseBundle> {
  const bound: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const ref = w.manifest.params[k];
    if (ref?.image && typeof v === "string") {
      if (!existsSync(v)) throw new Error(`Param ${k}: no file ${v}`);
      const up = await t.upload(basename(v), readFileSync(v));
      bound[k] = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    } else bound[k] = v;
  }
  const graph = bindParams(w, bound);
  const clientId = randomUUID();
  let finished: (() => void) | undefined, failed: ((e: Error) => void) | undefined;
  const done = new Promise<void>((res, rej) => { finished = res; failed = rej; });
  let promptId = "";
  const early: any[] = [];
  const handle = (m: any) => {
    const d = m?.data ?? {};
    if (!promptId) { early.push(m); return; }
    if (d.prompt_id && d.prompt_id !== promptId) return;
    if (m.type === "progress" && o.onProgress) o.onProgress(`${d.value}/${d.max}`);
    if (m.type === "execution_success" || (m.type === "executing" && d.node === null)) finished!();
    if (m.type === "execution_error") failed!(new Error(`ComfyUI failed in node ${d.node_id} (${d.node_type}): ${d.exception_message ?? "error"}`));
    if (m.type === "execution_interrupted") failed!(new Error("The ComfyUI run was interrupted."));
  };
  const sock = await t.listen(clientId, handle);
  try {
    const queued = await t.postJson("/prompt", { prompt: graph, client_id: clientId });
    if (queued?.error || queued?.node_errors && Object.keys(queued.node_errors).length) {
      const errs = Object.entries(queued.node_errors ?? {}).map(([n, e]: [string, any]) => `node ${n}: ${(e.errors ?? []).map((x: any) => x.message + (x.details ? ` (${x.details})` : "")).join("; ")}`);
      throw new Error(`ComfyUI refused the workflow: ${queued.error?.message ?? ""} ${errs.join(" | ")}`.trim());
    }
    promptId = String(queued.prompt_id);
    for (const m of early.splice(0)) handle(m);
    const abort = () => { void t.postJson("/interrupt", {}).catch(() => undefined); failed!(new Error("The ComfyUI run was cancelled.")); };
    if (o.signal?.aborted) abort();
    o.signal?.addEventListener("abort", abort, { once: true });
    // A cached run can finish before we listen: the history already has it.
    const already = await t.getJson(`/history/${promptId}`);
    if (already?.[promptId]?.status?.completed) finished!();
    await done;
    o.signal?.removeEventListener("abort", abort);
  } finally {
    sock.close();
  }
  const hist = (await t.getJson(`/history/${promptId}`))?.[promptId];
  if (!hist) throw new Error(`ComfyUI has no history for ${promptId}.`);
  const dir = join(o.outDir ?? join(sessionDir, "comfy", "runs"), promptId);
  mkdirSync(dir, { recursive: true });
  const files: BundleFile[] = [];
  for (const [node, role] of Object.entries(w.manifest.outputs)) {
    const out = hist.outputs?.[node] ?? {};
    const items = [...(out.images ?? []), ...(out.gifs ?? []), ...(out.files ?? [])] as { filename: string; subfolder?: string; type?: string }[];
    items.forEach((it, i) => {
      files.push({ role, node, path: join(dir, `${role.replace(/[^a-z0-9_-]+/gi, "_")}-${i + 1}-${it.filename}`) });
    });
    for (const [i, it] of items.entries()) {
      const q = new URLSearchParams({ filename: it.filename, subfolder: it.subfolder ?? "", type: it.type ?? "output" });
      writeFileSync(files[files.length - items.length + i].path, await t.download(`/view?${q}`));
    }
    // Text outputs (a pose node that returns keypoints as JSON in its UI output).
    for (const [k, v] of Object.entries(out)) {
      if (["images", "gifs", "files"].includes(k) || v === undefined) continue;
      const p = join(dir, `${role.replace(/[^a-z0-9_-]+/gi, "_")}-${k}.json`);
      writeFileSync(p, JSON.stringify(v, null, 2));
      files.push({ role, node, path: p });
    }
  }
  return { workflow: w.name, promptId, dir, files };
}

/** One line per file of a bundle, grouped by role. */
export function describeBundle(b: PoseBundle): string {
  const roles = [...new Set(b.files.map((f) => f.role))];
  return [`ComfyUI run of "${b.workflow}" (${b.promptId}): ${b.files.length} file${b.files.length === 1 ? "" : "s"} in ${b.dir}`,
    ...roles.map((r) => `- ${r}: ${b.files.filter((f) => f.role === r).map((f) => f.path).join(", ")}`)].join("\n");
}

// ---------------------------------------------------------------------------
// The image generator over ComfyUI (generate_image and generate_character run it when comfy.json names imageWorkflow)

/**
 * Runs comfy.json's imageWorkflow for generate_image: params prompt, and width and height when the manifest has
 * them (the aspect's size), and the first reference as `image` when it has an image param of that name. The first
 * output with the role "image" is the result.
 */
export class ComfyImageGenerator {
  readonly describe: string;
  constructor(private readonly workflow: string, private readonly t: () => ComfyTransport = () => httpTransport()) {
    this.describe = `the ComfyUI workflow "${workflow}" at ${comfyUrl()}`;
  }

  async generate(prompt: string, aspect: "square" | "portrait" | "landscape", signal: AbortSignal, refs: string[] = []) {
    const w = listWorkflows().workflows.find((x) => x.name === this.workflow);
    if (!w) throw new Error(`No ComfyUI workflow "${this.workflow}" in ${workflowsDir()} (comfy.json imageWorkflow).`);
    const [width, height] = aspect === "portrait" ? [832, 1216] : aspect === "landscape" ? [1216, 832] : [1024, 1024];
    const p = w.manifest.params;
    const values: Record<string, unknown> = { ...(p.prompt ? { prompt } : {}), ...(p.width ? { width } : {}), ...(p.height ? { height } : {}) };
    if (p.image?.image && refs[0]) values.image = refs[0];
    if (!p.prompt) throw new Error(`Workflow "${this.workflow}" has no prompt param.`);
    const b = await runWorkflow(this.t(), w, values, { signal });
    const file = b.files.find((f) => f.role === "image" && f.path.toLowerCase().endsWith(".png"));
    if (!file) throw new Error(`Workflow "${this.workflow}" returned no PNG with the role "image".`);
    const { decodePng } = await import("./image.js");
    const img = decodePng(readFileSync(file.path));
    return { path: file.path, width: img.width, height: img.height };
  }
}
