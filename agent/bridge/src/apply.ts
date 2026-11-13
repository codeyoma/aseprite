// Declarative apply (#88): the whole change as data. One `apply` call takes
// a list of ops (layers, cels and pixels, frames, tags, palette) and the
// extension runs them in one transaction (one undo step; the wire method
// `apply`, extension/handlers_apply.lua). A dry run checks them against the
// live sprite and lists what they would change; nothing is applied when any
// op fails, and every problem comes back with its op path (ops[2].color).
//
// The registered input keeps `ops` loose (an op name plus its keys) and the
// op grammar lives in the description: a full JSON Schema union of 16 ops
// would triple the tool's size in every model call. run() checks the strict
// schema below, so mistakes are still caught before anything is sent.
import { documentOf } from "./document.js";
import * as z from "zod/v4";
import { checkContent, snapshotContent } from "./core_tools.js";
import { failure, text, type Tool, type ToolResult } from "./tool.js";
import { framesSpec } from "./tool_inputs.js";
import { PROTOCOL } from "./protocol.js";

const int = z.number().int();
const layerRef = z.string().min(1).describe("Layer id ('L12') or name, also one added by an earlier op.");
const color = z.union([z.string().min(1), int.min(0)]);
const BLEND = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn", "hard_light",
  "soft_light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "addition", "subtract", "divide"] as const;
const hexColor = z.string().regex(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i, "a color is #rrggbb or #rrggbbaa");
// The ops' keys and base types come from protocol.json applyOps (#116), the one definition the extension and the
// fake share; the bridge adds value ranges and enums, by key name (a key means the same in every op).
const BASE: Record<string, z.ZodType> = {
  string: z.string(), integer: int, boolean: z.boolean(), any: z.any(), layer: layerRef, frames: framesSpec,
  "string[]": z.array(z.string()), "string{}": z.record(z.string(), z.string()), "integer[][]": z.array(z.array(int)),
};
const REFINED: Record<string, z.ZodType> = {
  name: z.string().min(1), rename: z.string().min(1),
  frame: int.min(1), from: int.min(1), to: int.min(1), after: int.min(1), duration: int.min(1), ms: int.min(1),
  w: int.min(1), h: int.min(1), count: int.min(1).max(256), repeat: int.min(0), opacity: int.min(0).max(255),
  blend: z.enum(BLEND), direction: z.enum(["forward", "reverse", "ping-pong", "ping-pong-reverse"]),
  color, rows: z.array(z.string()).min(1), points: z.array(z.tuple([int, int])).min(1), colors: z.array(hexColor).min(1),
};

/** One op's strict schema from its applyOps entry. */
function opSchemaOf(name: string, params: Record<string, string>) {
  const shape: Record<string, z.ZodType> = { op: z.literal(name) };
  for (const [key, type] of Object.entries(params)) {
    const optional = type.endsWith("?");
    const base = type.replace(/\?$/, "");
    const t = REFINED[key] ?? BASE[base];
    if (!t) throw new Error(`protocol.json applyOps.${name}.${key}: no schema for type ${type}`);
    shape[key] = optional ? t.optional() : t;
  }
  return z.strictObject(shape);
}

/** The ops, one strict object each, in protocol.json order. */
export const OP_SCHEMAS = Object.entries(PROTOCOL.applyOps)
  .filter(([k]) => k !== "description")
  .map(([name, params]) => opSchemaOf(name, params as Record<string, string>));

export const OP_NAMES = OP_SCHEMAS.map((s) => (s.shape.op as z.ZodLiteral<string>).value);
const opSchema = z.discriminatedUnion("op", OP_SCHEMAS as any);
export type ApplyOp = z.infer<typeof opSchema>;

/** "ops[2].color" from a zod path. */
function pathText(path: PropertyKey[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${String(p)}` : String(p))).join("");
}

/** Every structural problem of `ops`, one line each with its path; [] when they are well formed. */
export function checkOps(ops: unknown): string[] {
  if (!Array.isArray(ops) || ops.length === 0) return ["ops: list at least one op"];
  const problems: string[] = [];
  ops.forEach((op, i) => {
    if (!op || typeof op !== "object" || Array.isArray(op)) { problems.push(`ops[${i}]: expected an object with an op`); return; }
    const name = (op as any).op;
    if (!OP_NAMES.includes(name)) { problems.push(`ops[${i}].op: unknown op ${JSON.stringify(name)}; ops: ${OP_NAMES.join(", ")}`); return; }
    const r = opSchema.safeParse(op);
    if (r.success) return;
    for (const issue of r.error.issues) {
      const keys = issue.code === "unrecognized_keys" ? (issue as any).keys as string[] : undefined;
      const where = pathText(["ops", i, ...issue.path, ...(keys?.length === 1 ? keys : [])]);
      problems.push(`${where} (${name}): ${keys ? `unknown param${keys.length > 1 ? "s" : ""} ${keys.join(", ")}` : issue.message}`);
    }
  });
  return problems;
}

export const APPLY_DESCRIPTION =
  "Apply a whole change as data in ONE undo step: a list of ops run in order. Nothing changes when any op fails; " +
  "the errors list every problem by its path (ops[2]). dry_run: true checks the ops against the sprite and lists " +
  "what they would change, without changing it. Prefer it to execute_lua for layer, cel, pixel, frame, tag and palette " +
  "edits. Layers are ids ('L12') or names, also ones added by earlier ops; frames are 1-based and numbered as the " +
  "sprite is when that op runs; layer/frame default to the active ones. Colors: '#rrggbb[aa]', '.' (transparent) " +
  "or a palette index. Ops:\n" +
  "add_layer {name, group?, parent?(group), above?|below?(layer), opacity?(0-255), blend?, visible?}\n" +
  "set_layer {layer, name?, visible?, locked?, opacity?, blend?}\n" +
  "move_layer {layer, above?|below?|parent?}\n" +
  "delete_layer {layer}\n" +
  "pixels {layer?, frame?, x?, y?, rows, legend?}: read_pixels' grid ('. 3 3 .' rows, '-' keeps a pixel)\n" +
  "rect {layer?, frame?, x, y, w, h, color, fill?(default true; false: 1 px outline)}\n" +
  "line {layer?, frame?, points: [[x,y],...], color}: a 1 px polyline\n" +
  "clear_cel {layer, frames?}  move_cel {layer, frames?, dx?, dy?}\n" +
  "add_frames {count?, after?(default last), empty?(default: copies of `after`), duration?(ms)}\n" +
  "delete_frames {frames}  set_duration {frames?(default all), ms}\n" +
  "set_tag {name, from?, to?, direction?(forward|reverse|ping-pong|ping-pong-reverse), repeat?, rename?}: adds or changes\n" +
  "delete_tag {name}  set_palette {colors}  append_palette {colors}(adds the ones it lacks)\n" +
  "frames: 3, [1,2], '1-4' or 'all'. look/check return the snapshot and check findings with the result.";

export const APPLY_TOOLS: Tool[] = [
  {
    name: "apply",
    title: "Apply a change",
    description: APPLY_DESCRIPTION,
    input: z.object({
      ops: z.array(z.looseObject({ op: z.string() })).min(1).describe("The ops, in order: {op: 'rect', layer: 'Body', ...}."),
      dry_run: z.boolean().optional().describe("Only check the ops and list their changes; change nothing."),
      label: z.string().optional().describe("The undo step's name. Default 'Apply'."),
      look: z.union([z.boolean(), z.literal("filmstrip")]).optional().describe("After applying, also return a snapshot (true) or a filmstrip."),
      check: z.boolean().optional().describe("After applying, also run check and return its findings."),
    }),
    kind: "edit",
    label: (a) => (a?.dry_run ? "Check the change" : a?.label ? String(a.label) : Array.isArray(a?.ops) ? `Apply ${a.ops.length} ops` : "Apply a change"),
    async run({ ops, dry_run, label, look, check }, ctx) {
      const problems = checkOps(ops);
      if (problems.length) return failure(`Nothing changed. Fix these ops:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      // Through the Document module (#114), so its cached state is refreshed after the change.
      const out = formatApply(await documentOf(ctx).apply(ops, { dryRun: !!dry_run, label }));
      if (out.isError || dry_run) return out;
      if (look) out.content.push(...(await snapshotContent(ctx, look === "filmstrip" ? { view: "filmstrip" } : {})).content);
      if (check) out.content.push(...(await checkContent(ctx, {})).content);
      return out;
    },
  },
];

/** The wire result as text: the changes, the layers added, or every error by op path. */
export function formatApply(result: any): ToolResult {
  const errors = (result?.errors ?? []) as { path: string; type?: string; message: string }[];
  const changes = (result?.changes ?? []) as string[];
  if (errors.length) {
    const ran = changes.length ? `\nOps that ran before the rollback:\n${changes.map((c) => `- ${c}`).join("\n")}` : "";
    return failure(`Nothing changed (rolled back). Fix these ops:\n${errors.map((e) => `- ${e.path}${e.type ? ` (${e.type})` : ""}: ${e.message}`).join("\n")}${ran}`);
  }
  const head = result?.dryRun ? "Dry run, nothing changed. The ops would:" : "Applied in one undo step:";
  const made = (result?.layers ?? []) as { name: string; id: string }[];
  const layers = made.length ? `\nNew layers: ${made.map((l) => `${l.name} (${l.id})`).join(", ")}` : "";
  return { content: [text(`${head}\n${changes.map((c) => `- ${c}`).join("\n")}${layers}\nFrames: ${result?.frames ?? "?"}`)] };
}
