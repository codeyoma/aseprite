// Directions as tools (#43): plan the 4/8 directions, mirror the ones that
// can be mirrored, project top-down art to isometric, and draw an
// isometric grid guide.
import * as z from "zod/v4";
import { directionPlan, isoGrid, isoProject, mirroredTagName, MIRROR, tagDirection } from "./directions.js";
import { trim, type Rgba } from "./pixel_grid.js";
import type { AsepriteRequester, Tool, ToolResult } from "./tools.js";

const text = (t: string) => ({ type: "text" as const, text: t });
const failure = (t: string): ToolResult => ({ content: [text(t)], isError: true });

async function tagNames(aseprite: AsepriteRequester): Promise<{ tags: string[]; width: number; height: number }> {
  const { result } = await aseprite.request("execute_lua", {
    code: `local s = app.sprite if not s then error("No active sprite") end
      local o = {} for _, t in ipairs(s.tags) do o[#o + 1] = t.name end return { tags = o, width = s.width, height = s.height }`,
    transaction: false,
  });
  if (!result.ok) throw new Error(result.error);
  return { tags: result.value.tags ?? [], width: result.value.width, height: result.value.height };
}

export const DIRECTION_TOOLS: Tool[] = [
  {
    name: "direction_plan",
    title: "Plan directions",
    description:
      "Which of the 4 or 8 directions the sprite's tags cover (tags named like 'walk_E', 'SE', 'idle-north'), which " +
      "missing ones can be made by mirroring (E<->W, NE<->NW, SE<->SW), and which must be drawn.",
    input: z.object({ count: z.union([z.literal(4), z.literal(8)]).optional().describe("Default 8.") }),
    kind: "read",
    label: () => "Plan directions",
    async run({ count }, aseprite) {
      const { tags } = await tagNames(aseprite);
      const p = directionPlan(tags, (count ?? 8) as 4 | 8);
      const have = Object.entries(p.have).map(([d, t]) => `${d} (${t})`);
      return {
        content: [text([
          `Have: ${have.join(", ") || "none (name tags by direction, e.g. walk_S)"}.`,
          `Mirror: ${p.mirror.map((m) => `${m.to} from ${m.from} (${m.tag})`).join(", ") || "nothing"}.`,
          `Draw: ${p.draw.join(", ") || "nothing"}.`,
        ].join("\n"))],
      };
    },
  },
  {
    name: "mirror_direction",
    title: "Mirror direction",
    description:
      "Make a direction by mirroring another: copies a tag's frames to the end, flipped horizontally, as a new tag " +
      "named for the new direction (walk_E -> walk_W). keep_layers stay unflipped (asymmetric details: fix them by hand). " +
      "One undo step.",
    input: z.object({
      tag: z.string().describe("The tag to mirror, e.g. 'walk_E'."),
      to: z.string().optional().describe("The new direction (default: the mirror of the tag's)."),
      new_tag: z.string().optional(),
      keep_layers: z.array(z.string()).optional(),
    }),
    kind: "edit",
    label: (a) => (a.tag ? `Mirror ${a.tag}` : "Mirror direction"),
    async run(input, aseprite) {
      const from = tagDirection(input.tag);
      const to = input.to ?? (from ? MIRROR[from] : undefined);
      if (!to) return failure(`Can't tell the direction of '${input.tag}' or it has no mirror; pass 'to'.`);
      const name = input.new_tag ?? mirroredTagName(input.tag, from ?? "", to);
      const { result } = await aseprite.request("mirror_frames", { tag: input.tag, new_tag: name, keep_layers: input.keep_layers });
      return { content: [text(`Made ${name} (${to}) from ${input.tag}: frames ${result.from}-${result.to}, flipped` +
        (input.keep_layers?.length ? `, except ${input.keep_layers.join(", ")}` : "") + ".")] };
    },
  },
  {
    name: "iso_project",
    title: "Project to isometric",
    description: "Turn a top-down square tile or shape (a layer, active frame) into a 2:1 isometric diamond, pixel-exact, opened as a new sprite.",
    input: z.object({ layer: z.string().optional(), frame: z.number().int().min(1).optional() }),
    kind: "edit",
    label: () => "Project to isometric",
    async run(input, aseprite) {
      const { result, binary } = await aseprite.request("snapshot", { layer: input.layer, frame: input.frame });
      if (!binary) return failure("Aseprite sent no pixel data");
      const t = trim({ width: result.width, height: result.height, data: binary });
      const side = Math.max(t.width, t.height);
      // Square the trimmed art so the diamond is symmetric.
      const sq = new Uint8Array(side * side * 4);
      for (let y = 0; y < t.height; y++) sq.set(t.data.subarray(y * t.width * 4, (y + 1) * t.width * 4), y * side * 4);
      const iso: Rgba = isoProject({ width: side, height: side, data: sq });
      const r = await aseprite.request("create_sprite", { width: iso.width, height: iso.height, rgba: Buffer.from(iso.data).toString("base64"), title: "Isometric" });
      return { content: [text(`Projected a ${side}x${side} tile to a ${iso.width}x${iso.height} isometric diamond ("${r.result.title}").`)] };
    },
  },
  {
    name: "iso_grid",
    title: "Isometric grid guide",
    description: "Add a 2:1 isometric grid (tiles `tile` px wide) on an 'AI: iso grid' layer, as a drawing guide.",
    input: z.object({ tile: z.number().int().min(4).max(256).optional().describe("Tile width in px. Default 32.") }),
    kind: "edit",
    label: () => "Isometric grid",
    async run({ tile }, aseprite) {
      const { width, height } = await tagNames(aseprite);
      const g = isoGrid(width, height, tile ?? 32);
      await aseprite.request("put_image", { new_layer: "iso grid", width, height, rgba: Buffer.from(g.data).toString("base64") });
      return { content: [text(`Added a ${tile ?? 32}x${(tile ?? 32) / 2} isometric grid on 'AI: iso grid'. Hide or delete it before export.`)] };
    },
  },
];
