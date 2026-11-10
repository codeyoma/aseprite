// Export for game engines as a tool (#49).
import { tiledTileset } from "./export.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import * as z from "zod/v4";
import { godotSpriteFrames, jsonHash, pack, phaserAnims, placeLike, unityMeta, type Anim, type SheetInfo } from "./export.js";
import type { Rgba } from "./pixel_grid.js";
import { failure, text, type AsepriteRequester, type Tool, type ToolResult } from "./tool.js";


function writePng(path: string, img: Rgba) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  writeFileSync(path, PNG.sync.write(png));
}

async function snap(aseprite: AsepriteRequester, frame: number, layer?: string): Promise<Rgba> {
  const { result, binary } = await aseprite.request("snapshot", { frame, layer });
  if (!binary) throw new Error("Aseprite sent no pixel data");
  return { width: result.width, height: result.height, data: binary };
}

const HOWTO: Record<string, (n: string) => string> = {
  godot: (n) => `Godot 4
- Copy ${n}.png and ${n}.tres into your project (same folder; the .tres expects res://${n}.png — edit the path at the top if it lives elsewhere).
- Pixel art: Project Settings > Rendering > Textures > Default Texture Filter = Nearest.
- Add an AnimatedSprite2D and set Sprite Frames to ${n}.tres; the animations are the sprite's tags.
- Normal map (if ${n}_n.png exists): use a CanvasTexture with ${n}.png as diffuse and ${n}_n.png as normal, then rebuild the SpriteFrames on it, or apply it in a shader.
`,
  unity: (n) => `Unity
- Copy ${n}.png and ${n}.png.meta into Assets/ together (the meta holds the slices: Sprite Mode Multiple, Point filter, no compression).
- The slices are named ${n}_0, ${n}_1, …; build Animation Clips from them (select the frames of a tag and drag into the Scene).
- Pixels Per Unit is set in the meta; change it in the import settings if your game uses another.
- ${n}.json has the tags and durations for reference.
- Normal map (if ${n}_n.png exists): add it as a Secondary Texture named _NormalMap on ${n}.png.
`,
  phaser: (n) => `Phaser 3
- this.load.atlas("${n}", "${n}.png", "${n}.json");
- this.load.json("${n}_anims", "${n}_anims.json"); then in create(): this.anims.fromJSON(this.cache.json.get("${n}_anims"));
- this.add.sprite(x, y, "${n}").play("<tag name>");
- PixiJS: Assets.load("${n}.json") gives a Spritesheet with the same frames.
`,
  tiled: (n) => `Tiled
- ${n}.tsx is a tileset of the frames; add it with Map > Add External Tileset.
`,
  json: (n) => `${n}.json is Aseprite's JSON hash format (frames, durations, frameTags); most engines and libraries can read it.
`,
};

export const EXPORT_TOOLS: Tool[] = [
  {
    name: "export_for_engine",
    title: "Export for a game engine",
    description:
      "Export the sprite's frames as a sheet with metadata for an engine: 'godot' (SpriteFrames .tres with an " +
      "animation per tag), 'unity' (.png.meta with sliced sprites, point filtering, pivots), 'phaser' (JSON atlas + " +
      "animations, also PixiJS), 'tiled' (.tsx), or 'json' (Aseprite's hash format). Options: trim, padding, extrude " +
      "(stops edge bleeding), integer scale, power-of-two size. If a layer 'AI: normal …' exists, a matching <name>_n.png " +
      "is written too. Hidden layers are left out. Writes a HOW_TO_IMPORT.txt.",
    input: z.object({
      engine: z.enum(["godot", "unity", "phaser", "tiled", "json"]),
      dir: z.string(),
      name: z.string().optional().describe("Base file name. Default: the sprite's title."),
      trim: z.boolean().optional(),
      padding: z.number().int().min(0).max(16).optional(),
      extrude: z.number().int().min(0).max(8).optional(),
      scale: z.number().int().min(1).max(8).optional(),
      power_of_two: z.boolean().optional(),
      columns: z.number().int().min(1).max(64).optional(),
      pivot: z.enum(["bottom-center", "center", "top-left"]).optional().describe("Default bottom-center."),
      pixels_per_unit: z.number().int().min(1).max(512).optional().describe("Unity. Default: the frame height."),
    }),
    kind: "edit",
    label: (a) => (a.engine ? `Export for ${a.engine}` : "Export for engine"),
    async run(input, aseprite) {
      const { result } = await aseprite.request("execute_lua", {
        code: `local s = app.sprite if not s then error("No active sprite") end
          local d, t, normal = {}, {}, nil
          for i, f in ipairs(s.frames) do d[i] = math.floor(f.duration * 1000 + 0.5) end
          for _, g in ipairs(s.tags) do t[#t + 1] = { name = g.name, from = g.fromFrame.frameNumber - 1, to = g.toFrame.frameNumber - 1, dir = g.aniDir, repeats = g.repeats or 0 } end
          for _, l in ipairs(s.layers) do if l.name:match("^AI: normal") then normal = l.name end end
          return { durations = d, tags = t, normal = normal, title = app.fs.fileTitle(s.filename) }`,
        transaction: false,
      });
      if (!result.ok) return failure(result.error);
      const info = result.value;
      const durations: number[] = info.durations;
      const frames: Rgba[] = [];
      for (let f = 1; f <= durations.length; f++) frames.push(await snap(aseprite, f));
      const opts = { trim: input.trim, padding: input.padding, extrude: input.extrude, scale: input.scale, powerOfTwo: input.power_of_two, columns: input.columns };
      const { sheet, placed } = pack(frames, opts);
      const name = (input.name ?? info.title ?? "sprite").replace(/[^\w-]+/g, "_");
      const dirs: Record<number, Anim["direction"]> = { 0: "forward", 1: "reverse", 2: "pingpong", 3: "pingpong" };
      const anims: Anim[] = (info.tags ?? []).map((t: any) => ({ name: t.name, from: t.from, to: t.to, direction: dirs[t.dir] ?? "forward", loop: (t.repeats ?? 0) === 0 }));
      const pivots: Record<string, [number, number]> = { "bottom-center": [0.5, 1], center: [0.5, 0.5], "top-left": [0, 0] };
      const s: SheetInfo = { name, image: `${name}.png`, placed, durations, anims, width: sheet.width, height: sheet.height, pivot: pivots[input.pivot ?? "bottom-center"] };
      mkdirSync(input.dir, { recursive: true });
      const files = [`${name}.png`];
      writePng(join(input.dir, `${name}.png`), sheet);
      if (info.normal) {
        const normals: Rgba[] = [];
        for (let f = 1; f <= durations.length; f++) normals.push(await snap(aseprite, f, info.normal));
        writePng(join(input.dir, `${name}_n.png`), placeLike(normals, placed, sheet.width, sheet.height, opts));
        files.push(`${name}_n.png`);
      }
      const write = (file: string, body: string) => {
        writeFileSync(join(input.dir, file), body);
        files.push(file);
      };
      write(`${name}.json`, jsonHash(s));
      if (input.engine === "godot") write(`${name}.tres`, godotSpriteFrames(s, `res://${name}.png`));
      if (input.engine === "unity") write(`${name}.png.meta`, unityMeta(s, input.pixels_per_unit ?? frames[0].height));
      if (input.engine === "phaser") write(`${name}_anims.json`, phaserAnims(s, name));
      if (input.engine === "tiled") {
        write(`${name}.tsx`, tiledTileset(name, placed, sheet.width, sheet.height, opts));
      }
      write("HOW_TO_IMPORT.txt", HOWTO[input.engine](name));
      return { content: [text(`Exported ${frames.length} frames (${anims.length} animations) for ${input.engine} to ${input.dir}: ${files.join(", ")}. ` +
        `Sheet ${sheet.width}x${sheet.height}${input.trim ? ", trimmed" : ""}${input.extrude ? `, extruded ${input.extrude}px` : ""}. See HOW_TO_IMPORT.txt.`)] };
    },
  },
];
