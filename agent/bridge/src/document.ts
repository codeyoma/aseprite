// The document module (#52): what tool modules know about the active
// sprite and how pixels go in and out, over the existing wire requests
// (get_state, snapshot, put_image, create_sprite, create_animation). Tools
// call documentOf(aseprite) instead of writing Lua or encoding pixels.
import { parseHex, type RGBA } from "./color.js";
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

export interface Document {
  /** The active sprite (read once per document; writes invalidate it). */
  info(): Promise<SpriteInfo>;
  /** Frames from a spec: 3, [1, 2], "1-4", "all"; default the active frame. */
  frames(spec?: unknown): Promise<number[]>;
  /** A layer's pixels at sprite size (or the whole sprite when no layer). */
  pixels(layer: string | undefined, frame?: number): Promise<Rgba>;
  putImage(img: Rgba, o?: PutImage): Promise<{ layer: string; name: string }>;
  createSprite(img: Rgba, o?: NewSprite): Promise<{ title: string }>;
  createAnimation(width: number, height: number, frames: AnimationFrame[], o?: NewSprite & { tags?: { name: string; from: number; to: number }[] }): Promise<{ title: string }>;
}

const encode = (img: Rgba) => Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString("base64");

function checkSize(img: Rgba, what: string): void {
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(`${what}: ${img.data.length} bytes for ${img.width}x${img.height}`);
  }
}

/** Frame spec to frame numbers, against the sprite's frame count. */
export function resolveFrames(spec: unknown, count: number, active: number): number[] {
  let out: number[];
  if (spec === undefined || spec === null || spec === "") out = [active];
  else if (typeof spec === "number") out = [spec];
  else if (Array.isArray(spec)) out = spec.map(Number);
  else if (String(spec) === "all") out = Array.from({ length: count }, (_, i) => i + 1);
  else {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(spec));
    if (m) out = Array.from({ length: Math.max(0, +m[2] - +m[1] + 1) }, (_, i) => +m[1] + i).filter((f) => f <= count);
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
    out.push({ id: String(l.id ?? ""), name: l.name, visible: l.visible !== false, group: !!l.group, path });
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
  };
}

export function documentOf(aseprite: AsepriteRequester): Document {
  let cached: Promise<SpriteInfo> | undefined;
  const info = () => (cached ??= aseprite.request("get_state").then((r) => parseState(r.result)));
  const wrote = () => {
    cached = undefined;
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
      });
      wrote();
      return result;
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
  };
}
