// The document module (#52): what tool modules know about the active
// sprite and how pixels, colors, the palette and slices go in and out, over
// the existing wire requests. Tools call documentOf(aseprite) instead of
// writing Lua, encoding pixels or sending requests themselves; every write
// goes through here, so the cached SpriteInfo is dropped after it.
import { hex, parseHex, type Counted, type RGBA } from "./color.js";
import type { Rgba } from "./pixel_grid.js";
import type { AsepriteRequester } from "./tool.js";

export interface LayerInfo {
  /** Stable reference, "L<id>". */
  id: string;
  name: string;
  visible: boolean;
  group: boolean;
  /** Group names from the top, e.g. ["Body"] for a layer inside Body. */
  path: string[];
  /** Image layers: 0-255 and the blend mode's wire name (protocol.json blendModes). */
  opacity?: number;
  blendMode?: string;
  /** Image layers: groups of 2+ frames whose cels are linked (share one image), e.g. [[2, 3, 4]]. */
  links?: number[][];
}

/** A hit hit_stop recorded (sprite property aseprite-agent "fx.hits"), for exporters (#71). */
export interface HitInfo {
  /** The contact frame (1-based). */
  frame: number;
  /** How much longer the contact pose holds, shake included (ms). */
  freezeMs: number;
  shakeMs?: number;
  amp?: number;
}

export interface TagInfo {
  name: string;
  /** 1-based, inclusive. */
  from: number;
  to: number;
  direction: "forward" | "reverse" | "pingpong" | "pingpong_reverse";
  /** 0 = loop forever. */
  repeat: number;
}

export interface SpriteInfo {
  title: string;
  width: number;
  height: number;
  /** Duration of each frame in ms (frame 1 first). */
  durations: number[];
  /** The active frame (1-based). */
  frame: number;
  /** The active layer's name and id ("" when none). */
  layer: string;
  layerId: string;
  /** Every layer, top first, groups before their children. */
  layers: LayerInfo[];
  tags: TagInfo[];
  /** The sprite palette (first 256 colors), transparent entries skipped. */
  palette: RGBA[];
  selection?: { x: number; y: number; w: number; h: number };
  /** Slices; center is the 9-patch's stretchable part, relative to the slice. */
  slices: SliceInfo[];
  /** Hits recorded by hit_stop, in frame order of recording. */
  hits: HitInfo[];
  colorMode: "rgb" | "indexed" | "grayscale";
}

export interface SliceInfo {
  name: string;
  bounds: { x: number; y: number; w: number; h: number };
  center?: { x: number; y: number; w: number; h: number };
}

export interface PutImage {
  frame?: number;
  /** Write into this layer (name or id); default the active layer. */
  layer?: string;
  /** Or onto the 'AI: <newLayer>' layer, made on first use (reused by later frames). */
  newLayer?: string;
  /** Place the new layer above this one (name or id). */
  above?: string;
  hideSource?: boolean;
  /** Keep the new layer hidden (e.g. a normal map). */
  hide?: boolean;
  x?: number;
  y?: number;
  label?: string;
  /** The new layer's blend mode (protocol.json blendModes), e.g. "addition"; with newLayer only. */
  blendMode?: string;
  /** The new layer's opacity, 0-255; with newLayer only. */
  opacity?: number;
}

/**
 * Frames put right after frame `after` (numbered as before any insert), one per duration (ms). Every image
 * layer's cel there is linked to its cel in `after`, except shift.layers, which get copies moved by offsets[i].
 */
export interface FrameInsert {
  after: number;
  durations: number[];
  shift?: { layers: string[]; offsets: { x: number; y: number }[] };
}

/** putImages' options. */
export interface PutImagesOptions {
  /** The sprite gets at least this many frames (after the inserts), copies of the last one lasting duration ms. */
  frames?: number;
  duration?: number;
  label?: string;
  prompt?: string;
  /** Hex colors appended to the sprite palette (the ones it lacks). */
  palette?: string[];
  /** Frames inserted first (tags covering `after` grow, later tags and hits move). */
  insert?: FrameInsert[];
  /** Frame durations to set, numbered after the inserts. */
  durations?: { frame: number; ms: number }[];
  /** A hit to record (numbered after the inserts). */
  hit?: { frame: number; freezeMs: number; shakeMs?: number; amp?: number };
}

/** One image of putImages: put at (x, y) in a frame, onto a new 'AI: ' layer or into a layer. */
export interface PutImagesItem {
  image: Rgba;
  frame: number;
  layer?: string;
  newLayer?: string;
  /** A layer id or name, also one made earlier in the same call ('AI: <name>'). */
  above?: string;
  x?: number;
  y?: number;
  hide?: boolean;
  blendMode?: string;
  opacity?: number;
}

export interface NewSprite {
  title?: string;
  /** Palette colors as hex. */
  palette?: string[];
}

export interface AnimationFrame {
  image: Rgba;
  /** ms; default 100. */
  duration?: number;
}

/** Which cels a color request covers: a layer (or group) or all visible image layers, in frames (default all). */
export interface ColorTarget {
  layer?: string;
  /** Frame spec (see resolveFrames); default all frames. */
  frames?: unknown;
}

export interface CollectedColors {
  /** Distinct colors with pixel counts, most used first. */
  colors: Counted[];
  pixels: number;
  colorMode: "rgb" | "indexed" | "grayscale";
}

export interface MirrorFrames {
  /** Mirror this tag's frames, or `frames` (a frame spec). */
  tag?: string;
  frames?: unknown;
  /** Tag the new frames with this name. */
  newTag?: string;
  /** Layers copied unflipped. */
  keepLayers?: string[];
}

export interface SetSlice {
  name: string;
  /** Default 0, 0 and the sprite size. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** The 9-patch center, relative to the slice. */
  center?: { x: number; y: number; w: number; h: number };
}

export interface Document {
  /** The active sprite (read once per document; writes invalidate it). */
  info(): Promise<SpriteInfo>;
  /** Frames from a spec: 3, [1, 2], "1-4", "all"; default the active frame. */
  frames(spec?: unknown): Promise<number[]>;
  /** A layer's pixels at sprite size (or the whole sprite when no layer). */
  pixels(layer: string | undefined, frame?: number): Promise<Rgba>;
  putImage(img: Rgba, o?: PutImage): Promise<{ layer: string; name: string }>;
  /**
   * Several images and timeline edits in one undo step (PutImagesOptions): palette, inserts, frames at the
   * end, durations, a hit, then the images (frames numbered after the inserts). paletteAdded counts the
   * colors appended, inserted the frames inserted, added the frames added at the end.
   */
  putImages(items: PutImagesItem[], o?: PutImagesOptions):
    Promise<{ layers: { layer: string; name: string }[]; frames: number; added: number; inserted?: number; paletteAdded?: number }>;
  createSprite(img: Rgba, o?: NewSprite): Promise<{ title: string }>;
  createAnimation(width: number, height: number, frames: AnimationFrame[], o?: NewSprite & { tags?: { name: string; from: number; to: number }[] }): Promise<{ title: string }>;
  /** Text rendered by Aseprite in a font file or system font (PasteText spec), white, trimmed. */
  renderFontText(text: string, font: string, size: number): Promise<Rgba>;
  /** A new sprite with a tilemap layer: `set` cut into `count` tiles of `tile` px, placed by `map` (0-based indices, -1 empty). */
  createTilemap(set: Rgba, tile: number, columns: number, count: number, map: number[][], o?: { title?: string }): Promise<{ title: string; layer: string }>;
  /** Distinct colors of the target cels (hidden layers too with `hidden`; only the selection with `selection`). */
  colors(o?: ColorTarget & { selection?: boolean; hidden?: boolean }): Promise<CollectedColors>;
  /** Every entry of the sprite palette, transparent ones included (info().palette skips those). */
  palette(): Promise<RGBA[]>;
  /** Replaces the sprite palette, or with `append` adds the colors it lacks. One undo step. */
  setPalette(colors: RGBA[], o?: { append?: boolean; label?: string }): Promise<{ size: number }>;
  /** Recolors the target cels with a "#from" -> "#to" map (indexed sprites: palette entries). One undo step. */
  applyColorMap(map: Record<string, string>, o?: ColorTarget & { label?: string }): Promise<{ changed: number; mode: "pixels" | "palette entries" }>;
  /** Copies frames to new frames at the end, flipped horizontally (keepLayers unflipped), as a new tag. One undo step. */
  mirrorFrames(o: MirrorFrames): Promise<{ from: number; to: number; frames: number }>;
  /** Splits an image layer (default the active one; RGB sprites only) into one layer per color group, across frames. One undo step. */
  splitByColors(groups: { name: string; colors: string[] }[], o?: { layer?: string }): Promise<{ layers: string[] }>;
  /** Adds a slice, replacing one of the same name. */
  setSlice(o: SetSlice): Promise<{ slices: number }>;
  /** Draws a swatch strip of colors on a new 'AI: <name>' layer (default 'palette'). One undo step. */
  drawSwatches(colors: RGBA[], o?: { name?: string; size?: number }): Promise<{ layer?: string }>;
}

const encode = (img: Rgba) => Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString("base64");

function checkSize(img: Rgba, what: string): void {
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(`${what}: ${img.data.length} bytes for ${img.width}x${img.height}`);
  }
}

/**
 * Frame spec to frame numbers, against the sprite's frame count: the grammar
 * in protocol.json (params.frames). Tool inputs take a spec with
 * tool_inputs.framesSpec (or framesInput).
 */
export function resolveFrames(spec: unknown, count: number, active: number, fallback: "active" | "all" = "active"): number[] {
  let out: number[];
  if (spec === undefined || spec === null || spec === "") out = fallback === "all" ? Array.from({ length: count }, (_, i) => i + 1) : [active];
  else if (typeof spec === "number") out = [spec];
  else if (Array.isArray(spec)) out = spec.map(Number);
  else if (String(spec) === "all") out = Array.from({ length: count }, (_, i) => i + 1);
  else {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(spec));
    if (m) out = Array.from({ length: Math.max(0, +m[2] - +m[1] + 1) }, (_, i) => +m[1] + i);
    else if (/^\d+$/.test(String(spec).trim())) out = [Number(spec)];
    else throw new Error(`Frames must be a number, a list, 'a-b' or 'all' (got ${JSON.stringify(spec)})`);
  }
  const bad = out.find((f) => !Number.isInteger(f) || f < 1 || f > count);
  if (bad !== undefined) throw new Error(`Frame ${bad} is out of range (1-${count})`);
  return out;
}

function flatten(tree: any[], path: string[] = []): LayerInfo[] {
  const out: LayerInfo[] = [];
  for (const l of tree ?? []) {
    out.push({
      id: String(l.id ?? ""), name: l.name, visible: l.visible !== false, group: !!l.group, path,
      ...(l.group ? {} : { opacity: l.opacity, blendMode: l.blendMode, ...(l.celLinks ? { links: l.celLinks } : {}) }),
    });
    if (l.group) out.push(...flatten(l.layers, [...path, l.name]));
  }
  return out;
}

/** Parses a get_state reply into SpriteInfo (exported for tests). */
export function parseState(state: any): SpriteInfo {
  const s = state?.activeSprite;
  if (!s) throw new Error("No active sprite");
  const layers = flatten(s.layers);
  const active = layers.find((l) => l.id === state.activeLayerId);
  const title = String(s.filename ?? "").split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
  return {
    title,
    width: s.width,
    height: s.height,
    durations: (s.frames ?? []).map((f: any) => f.durationMs),
    frame: state.activeFrame ?? 1,
    layer: active?.name ?? "",
    layerId: active?.id ?? "",
    layers,
    tags: (s.tags ?? []).map((t: any) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction, repeat: t["repeat"] ?? 0 })),
    palette: (s.palette?.colors ?? []).map((h: string) => parseHex(h)!).filter((c: RGBA | undefined) => c && c.a > 0),
    selection: s.selection ? { x: s.selection.x, y: s.selection.y, w: s.selection.width, h: s.selection.height } : undefined,
    slices: (s.slices ?? []).filter((sl: any) => sl.bounds).map((sl: any) => ({
      name: sl.name,
      bounds: { x: sl.bounds.x, y: sl.bounds.y, w: sl.bounds.width, h: sl.bounds.height },
      center: sl.center ? { x: sl.center.x, y: sl.center.y, w: sl.center.width, h: sl.center.height } : undefined,
    })),
    colorMode: s.colorMode ?? "rgb",
    hits: (s.fxHits ?? []).map((h: any) => ({
      frame: h.frame, freezeMs: h.freezeMs, ...(h.shakeMs !== undefined ? { shakeMs: h.shakeMs } : {}), ...(h.amp !== undefined ? { amp: h.amp } : {}),
    })),
  };
}

export function documentOf(aseprite: AsepriteRequester): Document {
  let cached: Promise<SpriteInfo> | undefined;
  const info = () => (cached ??= aseprite.request("get_state").then((r) => parseState(r.result)));
  const wrote = () => {
    cached = undefined;
  };
  /** A write request: the cached info is stale after it (even when it failed halfway). */
  const write = async (method: string, params: Record<string, unknown>) => {
    try {
      return (await aseprite.request(method, params)).result;
    } finally {
      wrote();
    }
  };
  return {
    info,
    async frames(spec) {
      const i = await info();
      return resolveFrames(spec, i.durations.length, i.frame);
    },
    async pixels(layer, frame) {
      const { result, binary } = await aseprite.request("snapshot", { layer, frame });
      if (!binary) throw new Error("Aseprite sent no pixel data");
      const img = { width: result.width, height: result.height, data: new Uint8Array(binary) };
      checkSize(img, "snapshot");
      return img;
    },
    async putImage(img, o = {}) {
      checkSize(img, "put_image");
      const { result } = await aseprite.request("put_image", {
        width: img.width, height: img.height, rgba: encode(img),
        frame: o.frame, layer: o.layer, new_layer: o.newLayer, above: o.above,
        hide_source: o.hideSource, hide: o.hide, x: o.x, y: o.y, label: o.label,
        blend_mode: o.blendMode, opacity: o.opacity,
      });
      wrote();
      return result;
    },
    putImages(items, o = {}) {
      const images = items.map((it) => {
        checkSize(it.image, "put_images");
        const im: Record<string, unknown> = { width: it.image.width, height: it.image.height, rgba: encode(it.image), frame: it.frame };
        const opt = { layer: it.layer, new_layer: it.newLayer, above: it.above, x: it.x, y: it.y, hide: it.hide, blend_mode: it.blendMode, opacity: it.opacity };
        for (const [k, v] of Object.entries(opt)) if (v !== undefined) im[k] = v;
        return im;
      });
      const insert = o.insert?.map((x) => ({ after: x.after, durations: x.durations, ...(x.shift ? { shift: x.shift } : {}) }));
      const hit = o.hit && { frame: o.hit.frame, freeze_ms: o.hit.freezeMs, shake_ms: o.hit.shakeMs, amp: o.hit.amp };
      return write("put_images", {
        images, frames: o.frames, duration: o.duration, label: o.label, prompt: o.prompt, palette: o.palette,
        insert, durations: o.durations, hit,
      });
    },
    async createSprite(img, o = {}) {
      checkSize(img, "create_sprite");
      const { result } = await aseprite.request("create_sprite", { width: img.width, height: img.height, rgba: encode(img), title: o.title, palette: o.palette });
      wrote();
      return result;
    },
    async createAnimation(width, height, frames, o = {}) {
      for (const f of frames) checkSize(f.image, "create_animation");
      const { result } = await aseprite.request("create_animation", {
        width, height, title: o.title, palette: o.palette, tags: o.tags,
        frames: frames.map((f) => ({ rgba: encode(f.image), duration: f.duration ?? 100 })),
      }, 120_000);
      wrote();
      return result;
    },
    async renderFontText(text, font, size) {
      const { result, binary } = await aseprite.request("render_text", { text, font, size });
      if (!binary) throw new Error("Aseprite sent no pixel data");
      const img = { width: result.width, height: result.height, data: new Uint8Array(binary) };
      checkSize(img, "render_text");
      return img;
    },
    async createTilemap(set, tile, columns, count, map, o = {}) {
      checkSize(set, "create_tilemap");
      const { result } = await aseprite.request("create_tilemap", {
        tile, width: set.width, height: set.height, rgba: encode(set), columns, count, map, title: o.title,
      }, 120_000);
      wrote();
      return result;
    },
    async colors(o = {}) {
      const { result } = await aseprite.request("collect_colors", { layer: o.layer, frames: o.frames, selection: o.selection, hidden: o.hidden });
      return {
        colors: ((result.colors ?? []) as { hex: string; count: number }[]).map((c) => ({ ...parseHex(c.hex)!, count: c.count })),
        pixels: result.pixels ?? 0,
        colorMode: result.colorMode ?? "rgb",
      };
    },
    async palette() {
      const { result } = await aseprite.request("get_palette", {});
      return ((result.colors ?? []) as string[]).map((h) => parseHex(h)).filter((c): c is RGBA => !!c);
    },
    setPalette(colors, o = {}) {
      return write("set_palette", { colors: colors.map(hex), append: o.append, label: o.label });
    },
    applyColorMap(map, o = {}) {
      return write("apply_color_map", { map, layer: o.layer, frames: o.frames, label: o.label });
    },
    mirrorFrames(o) {
      return write("mirror_frames", { tag: o.tag, frames: o.frames, new_tag: o.newTag, keep_layers: o.keepLayers });
    },
    splitByColors(groups, o = {}) {
      return write("split_layer_by_colors", { layer: o.layer, groups });
    },
    async setSlice(o) {
      // The wire wants every bound: the sprite size fills in w and h.
      const size = o.w === undefined || o.h === undefined ? await info() : undefined;
      return write("set_slice", { name: o.name, x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? size!.width, h: o.h ?? size!.height, center: o.center });
    },
    drawSwatches(colors, o = {}) {
      return write("draw_swatches", { colors: colors.map(hex), name: o.name, size: o.size });
    },
  };
}
