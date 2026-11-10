// Export for game engines as a tool (#49), with effect timing, pivot and glow sheet (#71).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import { documentOf, type LayerInfo, type SpriteInfo } from "./document.js";
import {
  composeLight, composeNormal, godotNinePatch, godotSpriteFrames, jsonHash, pack, phaserAnims, placeLike, tiledTileset, unityMeta,
  type Anim, type FxMeta, type SheetInfo,
} from "./export.js";
import { writePng, type Rgba } from "./image.js";
import { text, type Tool } from "./tool.js";

const HOWTO: Record<string, (n: string) => string> = {
  godot: (n) => `Godot 4
- Copy ${n}.png and ${n}.tres into your project (same folder; the .tres expects res://${n}.png — edit the path at the top if it lives elsewhere).
- Pixel art: Project Settings > Rendering > Textures > Default Texture Filter = Nearest.
- Add an AnimatedSprite2D and set Sprite Frames to ${n}.tres; the animations are the sprite's tags.
- Normal map (if ${n}_n.png exists): use a CanvasTexture with ${n}.png as diffuse and ${n}_n.png as normal, then rebuild the SpriteFrames on it, or apply it in a shader.
- Masks (if ${n}_e.png / ${n}_s.png exist): ${n}_s.png is the CanvasTexture's specular texture; for the glow, draw ${n}_e.png on top with a CanvasItemMaterial set to Unshaded and Blend Mode Add (same frames).
- 9-patch (if ${n}_ninepatch.tscn exists): instance it for a stretchable panel or button; its NinePatchRect keeps the slice's border.
`,
  unity: (n) => `Unity
- Copy ${n}.png and ${n}.png.meta into Assets/ together (the meta holds the slices: Sprite Mode Multiple, Point filter, no compression).
- The slices are named ${n}_0, ${n}_1, …; build Animation Clips from them (select the frames of a tag and drag into the Scene).
- Pixels Per Unit is set in the meta; change it in the import settings if your game uses another.
- ${n}.json has the tags and durations for reference.
- Normal map (if ${n}_n.png exists): add it as a Secondary Texture named _NormalMap on ${n}.png.
- Masks (if ${n}_e.png / ${n}_s.png exist): add them as Secondary Textures (e.g. _Emission, _Specular) and sample them in a custom Sprite-Lit Shader Graph.
- 9-patch: a slice with a center sets each sprite's Border, so Image components with Image Type Sliced stretch only the middle.
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
  json: (n) => `${n}.json is Aseprite's JSON hash format (frames, durations, frameTags, slices with 9-patch centers); most engines and libraries can read it.
`,
};

/** Effect notes for HOW_TO_IMPORT.txt: the glow sheet and meta.fx, per engine. */
function fxHowto(engine: string, n: string, glow: boolean, fx: boolean, offset?: [number, number]): string {
  const lines: string[] = [];
  if (glow) {
    lines.push({
      godot: `- Glow: ${n}_glow.tres has the same animations on ${n}_glow.png; put a second AnimatedSprite2D with it over the first, with a CanvasItemMaterial set to Blend Mode Add, and play the same animation.`,
      phaser: `- Glow: this.load.atlas("${n}_glow", "${n}_glow.png", "${n}.json"); add a second sprite with .setBlendMode(Phaser.BlendModes.ADD) and play the same frames on it.`,
      unity: `- Glow: ${n}_glow.png has the frames at the same places; slice it like ${n}.png and draw it over the sprite with an additive material.`,
    }[engine] ?? `- Glow: ${n}_glow.png (meta.glow) has the frames at the same places as ${n}.png; draw it over them with additive blending.`);
  }
  if (offset) lines.push(`- Pivot: the effect's origin. On the AnimatedSprite2D (Centered on) set Offset to (${offset[0]}, ${offset[1]}) so the node's position is the origin.`);
  if (fx) lines.push(`- ${n}.json meta.fx: fps, loop, windup (ms from the effect's start to its impact), origin (px in a frame) and hits (0-based frame, freeze_ms) to time hit-stop in the game.`);
  return lines.length ? `Effects\n${lines.join("\n")}\n` : "";
}

/** A layer is shown when it and every group above it is visible (as Aseprite renders the sprite). */
export function shownImageLayers(info: SpriteInfo): LayerInfo[] {
  const groups = info.layers.filter((l) => l.group);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return info.layers.filter((l) => !l.group && l.visible &&
    l.path.every((name, i) => groups.find((g) => g.name === name && same(g.path, l.path.slice(0, i)))?.visible !== false));
}

/** Light layers: ones that do not blend Normal (as check treats them) or an effect's 'AI: fx … glow' layer. */
export const isLightLayer = (l: LayerInfo) => (l.blendMode ?? "normal") !== "normal" || /^AI: fx .+ glow$/.test(l.name);

/**
 * What the effects on a sprite mean for its export (#71). effects: the shown layers with an effect record, top
 * first. pure: every shown image layer is an effect or light, so the sprite is an effect sheet and its pivot
 * is the first effect's origin (a fraction of the frame); a character with effects keeps the default pivot.
 * fx: meta.fx (origins scaled), when there are effects or recorded hits.
 */
export function fxExport(info: SpriteInfo, scale = 1): { light: LayerInfo[]; pure: boolean; pivot?: [number, number]; fx?: FxMeta } {
  const shown = shownImageLayers(info);
  const light = shown.filter(isLightLayer);
  const effects = shown.filter((l) => l.fx);
  const pure = effects.length > 0 && shown.every((l) => l.fx || isLightLayer(l));
  const hits = info.hits.map((h) => ({
    frame: h.frame - 1, freeze_ms: h.freezeMs, ...(h.shakeMs !== undefined ? { shake_ms: h.shakeMs } : {}), ...(h.amp !== undefined ? { amp: h.amp } : {}),
  }));
  const list = effects.map((l) => ({
    id: l.fx!.id, layer: l.name, fps: l.fx!.fps, loop: l.fx!.loop, windup: l.fx!.windupMs, origin: { x: l.fx!.x * scale, y: l.fx!.y * scale },
  }));
  let fx: FxMeta | undefined;
  if (list.length) {
    const { id, fps, loop, windup, origin } = list[0];
    fx = { id, fps, loop, windup, origin, hits, ...(list.length > 1 ? { effects: list } : {}) };
  } else if (hits.length) fx = { hits };
  const first = effects[0]?.fx;
  return { light, pure, fx, ...(pure && first ? { pivot: [first.x / info.width, first.y / info.height] as [number, number] } : {}) };
}

export const EXPORT_TOOLS: Tool[] = [
  {
    name: "export_for_engine",
    title: "Export for a game engine",
    description:
      "Export the sprite's frames as a sheet with metadata for an engine: 'godot' (SpriteFrames .tres with an " +
      "animation per tag), 'unity' (.png.meta with sliced sprites, point filtering, pivots), 'phaser' (JSON atlas + " +
      "animations, also PixiJS), 'tiled' (.tsx), or 'json' (Aseprite's hash format). Options: trim, padding, extrude " +
      "(stops edge bleeding), integer scale, power-of-two size. If a layer 'AI: normal …' exists, a matching <name>_n.png " +
      "is written too (and <name>_e.png / <name>_s.png for 'AI: emission …' / 'AI: specular …'). Hidden layers are left out. " +
      "Effects (add_fx, fx_overlay, new_fx_sprite): the JSON gets meta.fx (fps, loop, windup, origin, hits for hit-stop); " +
      "a sprite of effects only is pivoted on the effect's origin unless pivot is given; light layers (Addition glow) go " +
      "to <name>_glow.png laid out like the color sheet (glow 'sheet', the default) or are baked into it ('baked'). " +
      "Writes a HOW_TO_IMPORT.txt.",
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
      pivot: z.enum(["bottom-center", "center", "top-left"]).optional()
        .describe("Default: the effect's origin for a sprite of effects only, else bottom-center."),
      glow: z.enum(["sheet", "baked"]).optional()
        .describe("Light layers (not blending Normal, or 'AI: fx … glow'): 'sheet' (default) writes them to <name>_glow.png, " +
          "same layout, left out of the color sheet; 'baked' composites them into the color sheet."),
      pixels_per_unit: z.number().int().min(1).max(512).optional().describe("Unity. Default: the frame height."),
    }),
    kind: "edit",
    label: (a) => (a.engine ? `Export for ${a.engine}` : "Export for engine"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      const durations = info.durations;
      const sc = input.scale ?? 1;
      const plan = fxExport(info, sc);
      const glowSheet = plan.light.length > 0 && (input.glow ?? "sheet") === "sheet";
      const extra: [string, string][] = [["normal", "_n"], ["emission", "_e"], ["specular", "_s"]];
      const frames: Rgba[] = [], glows: Rgba[] = [];
      const layerPixels = async (ls: LayerInfo[], f: number) =>
        Promise.all(ls.map(async (l) => ({ image: await doc.pixels(l.id, f), opacity: l.opacity ?? 255 })));
      // Bottom first, as they are composed.
      const colorLayers = shownImageLayers(info).filter((l) => !isLightLayer(l)).reverse();
      const lightLayers = [...plan.light].reverse();
      for (let f = 1; f <= durations.length; f++) {
        if (!glowSheet) { frames.push(await doc.pixels(undefined, f)); continue; }
        frames.push(composeNormal(await layerPixels(colorLayers, f), info.width, info.height));
        glows.push(composeLight(await layerPixels(lightLayers, f), info.width, info.height));
      }
      const opts = { trim: input.trim, padding: input.padding, extrude: input.extrude, scale: input.scale, powerOfTwo: input.power_of_two, columns: input.columns };
      const { sheet, placed } = pack(frames, opts, glowSheet ? glows : undefined);
      const name = (input.name ?? info.title ?? "sprite").replace(/[^\w-]+/g, "_");
      const dirs: Record<string, Anim["direction"]> = { forward: "forward", reverse: "reverse", pingpong: "pingpong", pingpong_reverse: "pingpong" };
      // Anim frames are 0-based; the document's tags are 1-based.
      const anims: Anim[] = info.tags.map((t) => ({ name: t.name, from: t.from - 1, to: t.to - 1, direction: dirs[t.direction] ?? "forward", loop: t.repeat === 0 }));
      const pivots: Record<string, [number, number]> = { "bottom-center": [0.5, 1], center: [0.5, 0.5], "top-left": [0, 0] };
      // An explicit pivot wins, then an effect sheet's origin, else bottom-center.
      const pivot = input.pivot ? pivots[input.pivot] : plan.pivot ?? pivots["bottom-center"];
      const s: SheetInfo = {
        name, image: `${name}.png`, placed, durations, anims, width: sheet.width, height: sheet.height, pivot, slices: info.slices,
        framePivot: !!input.pivot || !!plan.pivot, fx: plan.fx, ...(glowSheet ? { glow: `${name}_glow.png` } : {}),
      };
      mkdirSync(input.dir, { recursive: true });
      const files = [`${name}.png`];
      writePng(join(input.dir, `${name}.png`), sheet);
      if (glowSheet) {
        writePng(join(input.dir, `${name}_glow.png`), placeLike(glows, placed, sheet.width, sheet.height, opts));
        files.push(`${name}_glow.png`);
      }
      for (const [kind, suffix] of extra) {
        const layer = info.layers.find((l) => l.name.startsWith(`AI: ${kind}`));
        if (!layer) continue;
        const imgs: Rgba[] = [];
        for (let f = 1; f <= durations.length; f++) imgs.push(await doc.pixels(layer.id, f));
        writePng(join(input.dir, `${name}${suffix}.png`), placeLike(imgs, placed, sheet.width, sheet.height, opts));
        files.push(`${name}${suffix}.png`);
      }
      const write = (file: string, body: string) => {
        writeFileSync(join(input.dir, file), body);
        files.push(file);
      };
      write(`${name}.json`, jsonHash(s));
      if (input.engine === "godot") {
        write(`${name}.tres`, godotSpriteFrames(s, `res://${name}.png`));
        if (glowSheet) write(`${name}_glow.tres`, godotSpriteFrames(s, `res://${name}_glow.png`));
        const nine = godotNinePatch(s, `res://${name}.png`);
        if (nine) write(`${name}_ninepatch.tscn`, nine);
      }
      if (input.engine === "unity") write(`${name}.png.meta`, unityMeta(s, input.pixels_per_unit ?? frames[0].height));
      if (input.engine === "phaser") write(`${name}_anims.json`, phaserAnims(s, name));
      if (input.engine === "tiled") {
        write(`${name}.tsx`, tiledTileset(name, placed, sheet.width, sheet.height, opts));
      }
      // Godot has no pivot in SpriteFrames: the offset that puts a centered sprite's pivot on the node.
      const W = info.width * sc, H = info.height * sc;
      const offset: [number, number] | undefined = input.engine === "godot" && plan.pivot && !input.pivot
        ? [Math.round(W / 2 - pivot[0] * W), Math.round(H / 2 - pivot[1] * H)] : undefined;
      write("HOW_TO_IMPORT.txt", HOWTO[input.engine](name) + fxHowto(input.engine, name, glowSheet, !!plan.fx, offset));
      const notes: string[] = [];
      if (plan.pivot && !input.pivot) notes.push(`Pivot: the effect's origin (${plan.fx!.origin!.x}, ${plan.fx!.origin!.y} px).`);
      if (plan.fx) notes.push(`meta.fx: ${plan.fx.id ? `${plan.fx.id}, ${plan.fx.fps} fps, ${plan.fx.loop ? "loop" : "one-shot"}, windup ${plan.fx.windup} ms, ` : ""}${plan.fx.hits.length} hit${plan.fx.hits.length === 1 ? "" : "s"}.`);
      if (plan.light.length) {
        notes.push(glowSheet ? `Glow: ${plan.light.map((l) => l.name).join(", ")} in ${name}_glow.png, left out of ${name}.png.`
          : `Glow: ${plan.light.map((l) => l.name).join(", ")} baked into ${name}.png.`);
      }
      return { content: [text(`Exported ${frames.length} frames (${anims.length} animations) for ${input.engine} to ${input.dir}: ${files.join(", ")}. ` +
        `Sheet ${sheet.width}x${sheet.height}${input.trim ? ", trimmed" : ""}${input.extrude ? `, extruded ${input.extrude}px` : ""}. ` +
        `${notes.length ? notes.join(" ") + " " : ""}See HOW_TO_IMPORT.txt.`)] };
    },
  },
];
