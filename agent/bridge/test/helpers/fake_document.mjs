// An in-memory sprite behind the AsepriteRequester seam (#52): answers every
// request the document module sends (get_state, snapshot, put_image,
// put_images, create_sprite, create_animation, create_tilemap, and the color,
// palette, mirror, split and slice requests) the way the extension's handlers do
// (document_handlers.lua, handlers_color.lua, handlers_sprite.lua), so tool
// modules run in unit tests.
//
// The contract scenarios (agent/tests/contract/*.json) are replayed against
// this fake (test/contract.test.mjs) and against the real handlers in a
// headless Aseprite (agent/tests/contract_test.lua); both must pass. What the
// fake does not model throws "fake document: ... not supported" instead of
// answering differently.
//
// Model: layers form a tree (groups hold children, bottom first, like
// Aseprite's sprite.layers). A cel keeps its position and size, as in
// Aseprite: writes are not clipped to the canvas, and off-canvas pixels count
// in collect_colors and apply_color_map. RGB cels hold RGBA bytes, indexed
// cels hold palette indexes (0 is transparent). Grayscale sprites hold no
// pixels. Layers keep a blend mode and opacity, but snapshots of the sprite
// only blend normal layers at full opacity: anything else is refused.
import { resolveFrames } from "../../dist/document.js";
import { checkParams, PROTOCOL } from "../../dist/protocol.js";

const hex = (r, g, b, a = 255) => "#" + [r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, "0")).join("");
const hexAt = (d, i) => hex(d[i], d[i + 1], d[i + 2], d[i + 3]);
/** "#rrggbb" or "#rrggbbaa" (# optional) to [r, g, b, a], with the extension's error (pixels.lua parseHex). */
const parse = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(String(h));
  if (!m) throw new Error(`Invalid color: ${h} (use #rrggbb or #rrggbbaa)`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) : 255];
};
/** Normalized hex ("#rrggbb", "#rrggbbaa" when not opaque), as the extension writes it. */
const norm = (h) => hex(...parse(h));
const unsupported = (what) => new Error(`fake document: ${what} not supported`);
const decode = (s) => new Uint8Array(Buffer.from(s ?? "", "base64"));
/** app.fs.fileTitle: the file name without folder and extension. */
const fileTitle = (f) => String(f).split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
const DIRECTIONS = { forward: "forward", reverse: "reverse", pingpong: "ping-pong", "ping-pong": "ping-pong" };
/** Wire blend mode names (protocol.json blendModes). */
const BLEND_MODES = new Set(["normal", "multiply", "screen", "overlay", "darken", "lighten", "color_dodge", "color_burn", "hard_light",
  "soft_light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "addition", "subtract", "divide"]);
/** put_images item keys (handlers_sprite.lua IMAGE_KEYS). */
const IMAGE_KEYS = new Set(["width", "height", "rgba", "frame", "new_layer", "layer", "above", "x", "y", "hide", "blend_mode", "opacity"]);

// Aseprite's normal blend (doc/blend_funcs.cpp rgba_blender_normal) at full opacity, as drawSprite composites layers.
const mul = (a, b) => { const t = a * b + 0x80; return ((t >> 8) + t) >> 8; };
function blendOver(dst, i, src, j) {
  const Sa = src[j + 3];
  if (!dst[i + 3]) { dst.set(src.subarray(j, j + 4), i); return; }
  if (!Sa) return;
  const Ba = dst[i + 3], Ra = Sa + Ba - mul(Ba, Sa);
  for (let k = 0; k < 3; k++) dst[i + k] = Ra === 0 ? 0 : dst[i + k] + Math.trunc((src[j + k] - dst[i + k]) * Sa / Ra);
  dst[i + 3] = Ra;
}

/**
 * layers: bottom first: [{ name, visible?, group?, layers? (a group's children, bottom first),
 *   frames: [cel per frame] }]; a cel is a sprite-size RGBA Uint8Array (placed at 0, 0) or
 *   { x, y, width, height, data } (RGBA), undefined for none.
 * opts: { width, height, frames, durations, palette: ["#rrggbb"], tags, frame, layer (name),
 *         colorMode: "rgb" | "indexed" | "grayscale", selection: { x, y, width, height },
 *         slices: [{ name, bounds: { x, y, width, height }, center? }], title }
 * Indexed sprites take RGBA cels too: each color must be a palette entry other than index 0.
 * extra: request handlers that replace or add to the built-in ones.
 */
export function fakeDocument({
  width, height, frames = 1, durations, layers = [], palette = ["#000000", "#ffffff"], tags = [], frame = 1, layer,
  colorMode = "rgb", selection, slices = [], title, extra = {},
}) {
  let nextId = 1;
  const sprite = {
    title: title ?? "Sprite", width, height, colorMode, selection,
    palette: palette.map(norm), defaultPalette: false,
    tags: tags.map((t) => ({ ...t, direction: DIRECTIONS[t.direction] ?? "forward" })),
    slices: slices.map((s) => ({ ...s })),
    durations: durations ? [...durations] : Array.from({ length: frames }, () => 100),
    layers: [],
  };
  // The palette index of a color in an indexed sprite (exact entries only, never the transparent index 0).
  const indexOf = (s, r, g, b, a) => {
    if (a === 0) return 0;
    const h = hex(r, g, b, a);
    const i = s.palette.findIndex((c, k) => k > 0 && c === h);
    if (i < 0) throw unsupported(`${h} in an indexed sprite (Aseprite maps it to the nearest palette entry), which is`);
    return i;
  };
  // A cel from RGBA bytes, stored in the sprite's color mode.
  const makeCel = (s, x, y, w, h, rgba) => {
    if (s.colorMode === "rgb") return { x, y, width: w, height: h, data: new Uint8Array(rgba) };
    if (s.colorMode === "indexed") {
      const data = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) data[i] = indexOf(s, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]);
      return { x, y, width: w, height: h, data };
    }
    throw unsupported(`pixels in a ${s.colorMode} sprite`);
  };
  // A cel's pixels as RGBA (indexed: through the palette, as pixels.lua toRgbImage).
  const rgbaOf = (s, cel) => {
    if (s.colorMode !== "indexed") return cel.data;
    const out = new Uint8Array(cel.width * cel.height * 4);
    cel.data.forEach((idx, i) => { if (idx !== 0 && idx < s.palette.length) out.set(parse(s.palette[idx]), i * 4); });
    return out;
  };
  const build = (s, list, parent) => list.map((l) => {
    const node = { id: nextId++, name: l.name, visible: l.visible !== false, group: !!l.group, parent, cels: [], blendMode: "normal", opacity: 255 };
    if (l.group) node.layers = build(s, l.layers ?? [], node);
    else node.cels = (l.frames ?? []).map((c) => {
      if (!c) return undefined;
      if (c instanceof Uint8Array) return makeCel(s, 0, 0, s.width, s.height, c);
      return makeCel(s, c.x ?? 0, c.y ?? 0, c.width, c.height, c.data);
    });
    return node;
  });
  sprite.layers = build(sprite, layers, null);

  const sprites = [sprite];
  // Every layer, bottom first, groups before their children (the order the extension searches).
  const walk = (list, out = []) => {
    for (const l of list) { out.push(l); if (l.group) walk(l.layers, out); }
    return out;
  };
  const named = (s, name) => walk(s.layers).find((l) => l.name === name);
  let active = { sprite, frame, layer: layer !== undefined ? named(sprite, layer) : walk(sprite.layers).filter((x) => !x.group).at(-1) };
  const calls = [];
  const newSprite = (s) => ({ title: "Sprite", colorMode: "rgb", slices: [], tags: [], palette: [], defaultPalette: false, ...s });
  // A layer by id ("L12" or 12) or by name, as document_view.lua layerById.
  const byRef = (ref) => {
    if (ref === undefined || ref === null) return undefined;
    const all = walk(active.sprite.layers), id = String(ref).replace(/^L/, "");
    return all.find((l) => String(l.id) === id) ?? all.find((l) => l.name === String(ref));
  };
  const siblings = (l) => (l.parent ? l.parent.layers : active.sprite.layers);
  const detach = (l) => { const sib = siblings(l); sib.splice(sib.indexOf(l), 1); };
  // A new image layer just above ref, in ref's parent (on top when there is no ref).
  const newLayerAbove = (name, ref) => {
    const l = { id: nextId++, name, visible: true, group: false, parent: ref ? ref.parent : null, cels: [], blendMode: "normal", opacity: 255 };
    const sib = ref ? siblings(ref) : active.sprite.layers;
    sib.splice(ref ? sib.indexOf(ref) + 1 : sib.length, 0, l);
    return l;
  };
  // variations.lua aiLayer: a new "AI: <task>" layer above the active layer (or `above`), made active.
  const aiLayer = (task, above) => {
    const l = newLayerAbove(`AI: ${task}`, above ?? active.layer);
    active.layer = l;
    return l;
  };
  // Visible image layers through visible groups (as the snapshot renders them), as document_handlers.lua imageLayers.
  const imageLayers = (list, out = []) => {
    for (const l of list) {
      if (l.group) { if (l.visible) imageLayers(l.layers, out); }
      else if (l.visible) out.push(l);
    }
    return out;
  };
  const blank = () => new Uint8Array(active.sprite.width * active.sprite.height * 4);
  // Draws a cel onto a sprite-size RGBA buffer (clipped to the canvas), copying or blending.
  const draw = (out, s, cel, blend) => {
    const src = rgbaOf(s, cel);
    for (let y = 0; y < cel.height; y++) for (let x = 0; x < cel.width; x++) {
      const sx = x + cel.x, sy = y + cel.y;
      if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) continue;
      const i = (sy * s.width + sx) * 4, j = (y * cel.width + x) * 4;
      if (blend) blendOver(out, i, src, j);
      else out.set(src.subarray(j, j + 4), i);
    }
  };
  const layerImage = (s, l, f) => {
    const out = new Uint8Array(s.width * s.height * 4);
    if (l.cels[f - 1]) draw(out, s, l.cels[f - 1], false);
    return out;
  };
  // Image:drawSprite: visible layers in visible groups, blended bottom to top.
  const composite = (s, f) => {
    const out = new Uint8Array(s.width * s.height * 4);
    const paint = (list) => {
      for (const l of list) {
        if (!l.visible) continue;
        if (l.group) paint(l.layers);
        else if (l.cels[f - 1]) {
          if ((l.blendMode ?? "normal") !== "normal" || (l.opacity ?? 255) !== 255) {
            throw unsupported(`blending layer '${l.name}' (${l.blendMode}, opacity ${l.opacity}) into a snapshot`);
          }
          draw(out, s, l.cels[f - 1], true);
        }
      }
    };
    paint(s.layers);
    return out;
  };
  // The image layers and frames a color request covers, as colorTargets in handlers_color.lua.
  const colorTargets = (p) => {
    let ls;
    if (p.layer !== undefined) {
      const l = byRef(p.layer);
      ls = l.group ? imageLayers(l.layers) : [l];
    } else ls = imageLayers(active.sprite.layers);
    return { layers: ls, frames: p.frames };
  };
  const inSelection = (x, y) => {
    const sel = active.sprite.selection;
    return x >= sel.x && y >= sel.y && x < sel.x + sel.width && y < sel.y + sel.height;
  };
  const checkBytes = (bytes, w, h, prefix = "") => {
    if (bytes.length !== w * h * 4) throw new Error(`${prefix}${prefix ? "e" : "E"}xpected ${w * h * 4} bytes, got ${bytes.length}`);
  };
  const setPaletteOf = (s, colors) => {
    if (colors && colors.length > 0) { s.palette = colors.map(norm); s.defaultPalette = false; } else s.defaultPalette = true;
  };
  const describe = (list) => [...list].reverse().map((l) => ({
    id: `L${l.id}`, name: l.name, visible: l.visible, group: l.group,
    ...(l.group ? { layers: describe(l.layers) } : {
      opacity: l.opacity ?? 255, blendMode: l.blendMode ?? "normal",
      celFrames: l.cels.flatMap((c, i) => (c ? [i + 1] : [])),
      ...(l.tilemap ? { tilemap: true } : {}),
    }),
  }));
  const pathOf = (l) => (l.parent ? `${pathOf(l.parent)}/${l.name}` : l.name);
  // A new layer's blend mode and opacity from wire params, checked first (handlers_sprite.lua layerLook).
  const layerLook = (p, what) => {
    if (p.blend_mode !== undefined && !BLEND_MODES.has(p.blend_mode)) throw new Error(`${what}Unknown blend mode: ${p.blend_mode}`);
    if (p.opacity !== undefined && (!Number.isInteger(p.opacity) || p.opacity < 0 || p.opacity > 255)) throw new Error(`${what}opacity must be an integer from 0 to 255`);
    if ((p.blend_mode !== undefined || p.opacity !== undefined) && !p.new_layer) throw new Error(`${what}blend_mode and opacity apply to a new layer (new_layer)`);
    return { blendMode: p.blend_mode, opacity: p.opacity };
  };
  // One image into a frame (handlers_sprite.lua putOne): onto the 'AI: <new_layer>' layer (made once, reused) or into a layer.
  const putOne = (s, p, bytes, frame, look) => {
    let target;
    if (p.new_layer) {
      const name = `AI: ${p.new_layer}`;
      let source;
      if (p.above !== undefined) {
        source = byRef(p.above);
        if (!source) throw new Error(`Layer not found: ${p.above}`);
      }
      // Reuse the layer made for an earlier frame: among the source's siblings first, then anywhere.
      const find = (list) => walk(list).find((l) => !l.group && l.name === name);
      target = find(source ? siblings(source) : s.layers) ?? find(s.layers);
      if (!target) target = aiLayer(p.new_layer, source);
      if (p.hide_source && source) source.visible = false;
      if (p.hide) target.visible = false;
      if (look.blendMode !== undefined) target.blendMode = look.blendMode;
      if (look.opacity !== undefined) target.opacity = look.opacity;
    } else {
      target = p.layer !== undefined ? byRef(p.layer) : active.layer;
      if (!target || target.group) throw new Error("No image layer to write to");
    }
    target.cels[frame - 1] = makeCel(s, p.x ?? 0, p.y ?? 0, p.width, p.height, bytes);
    return target;
  };

  const handlers = {
    get_state: () => {
      const s = active.sprite;
      return {
        activeFrame: active.frame,
        activeLayerId: active.layer ? `L${active.layer.id}` : undefined,
        activeLayer: active.layer ? pathOf(active.layer) : undefined,
        activeSprite: {
          filename: s.title, width: s.width, height: s.height, colorMode: s.colorMode,
          frameCount: s.durations.length, layerCount: s.layers.length,
          frames: s.durations.map((d, i) => ({ frame: i + 1, durationMs: d })),
          // Top layer first, as get_state reports them.
          layers: describe(s.layers),
          tags: s.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction ?? "forward", repeat: 0 })),
          // A new sprite's default palette comes from the user's preferences; the fake reports it empty.
          palette: { size: s.palette.length, colors: s.palette.slice(0, 256) },
          ...(s.slices.length ? { slices: s.slices.map((x) => ({ ...x })) } : {}),
          ...(s.selection ? { selection: { ...s.selection } } : {}),
        },
      };
    },
    snapshot: (p) => {
      const s = active.sprite, f = p.frame;
      let data;
      if (p.layer !== undefined) {
        const l = byRef(p.layer);
        if (l.group) throw new Error("Snapshot of a group layer is not supported; snapshot the sprite instead");
        data = layerImage(s, l, f);
      } else data = composite(s, f);
      return [{ width: s.width, height: s.height, frame: f, layer: p.layer }, data];
    },
    put_image: (p) => {
      const bytes = decode(p.rgba);
      checkBytes(bytes, p.width, p.height);
      const target = putOne(active.sprite, p, bytes, p.frame, layerLook(p, ""));
      return { layer: `L${target.id}`, name: target.name };
    },
    // Several images in one undo step; the sprite first gets at least `frames` frames, copies of the last one.
    put_images: (p) => {
      const s = active.sprite;
      if (!p.images.length) throw new Error("No images");
      const count = Math.max(s.durations.length, p.frames ?? 0);
      if (p.duration !== undefined && p.duration < 1) throw new Error("duration must be at least 1 ms");
      const checked = p.images.map((im, i) => {
        const what = `Image ${i + 1}: `;
        if (!im || typeof im !== "object" || Array.isArray(im)) throw new Error(`${what}expected an object`);
        for (const k of Object.keys(im)) if (!IMAGE_KEYS.has(k)) throw new Error(`${what}unknown param '${k}'`);
        if (!Number.isInteger(im.width) || !Number.isInteger(im.height) || typeof im.rgba !== "string") throw new Error(`${what}width, height and rgba are required`);
        if (!Number.isInteger(im.frame)) throw new Error(`${what}frame is required`);
        if (im.frame < 1 || im.frame > count) throw new Error(`${what}frame ${im.frame} is out of range (1-${count})`);
        const bytes = decode(im.rgba);
        if (bytes.length !== im.width * im.height * 4) throw new Error(`${what}expected ${im.width * im.height * 4} bytes, got ${bytes.length}`);
        return { bytes, look: layerLook(im, what) };
      });
      // palette: colors the palette lacks (normalized hex), appended first in the same step.
      let paletteAdd;
      if (p.palette !== undefined) {
        const have = new Set(s.palette);
        paletteAdd = [];
        for (const c of p.palette.map(norm)) if (!have.has(c)) { have.add(c); paletteAdd.push(c); }
        if (paletteAdd.length && s.defaultPalette) throw unsupported("appending to the default palette of a new sprite");
      }
      if (paletteAdd) s.palette.push(...paletteAdd);
      let added = 0;
      // Sprite:newFrame: a copy of the last frame's cels (every image layer), with its duration unless one is given.
      while (s.durations.length < count) {
        const last = s.durations.length;
        s.durations.push(p.duration ?? s.durations[last - 1]);
        for (const l of walk(s.layers)) {
          const c = !l.group && l.cels[last - 1];
          if (c) l.cels[last] = { ...c, data: new Uint8Array(c.data) };
        }
        added++;
      }
      const layers = [], seen = new Set();
      p.images.forEach((im, i) => {
        const target = putOne(s, { ...im, prompt: p.prompt }, checked[i].bytes, im.frame, checked[i].look);
        if (!seen.has(target.id)) { seen.add(target.id); layers.push({ layer: `L${target.id}`, name: target.name }); }
      });
      return { layers, frames: s.durations.length, added, ...(paletteAdd ? { paletteAdded: paletteAdd.length } : {}) };
    },
    create_sprite: (p) => {
      const bytes = decode(p.rgba);
      checkBytes(bytes, p.width, p.height);
      const s = newSprite({ width: p.width, height: p.height, durations: [100] });
      s.layers = [{ id: nextId++, name: "Layer 1", visible: true, group: false, parent: null, cels: [makeCel(s, 0, 0, p.width, p.height, bytes)] }];
      setPaletteOf(s, p.palette);
      if (p.title) s.title = p.title;
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { width: p.width, height: p.height, title: fileTitle(s.title) };
    },
    create_animation: (p) => {
      if (!p.frames.length) throw new Error("No frames");
      const s = newSprite({ width: p.width, height: p.height, durations: [] });
      const l = { id: nextId++, name: "Layer 1", visible: true, group: false, parent: null, cels: [] };
      s.layers = [l];
      p.frames.forEach((f, i) => {
        const bytes = decode(f.rgba);
        checkBytes(bytes, p.width, p.height, `Frame ${i + 1}: `);
        s.durations.push(f.duration ?? 100);
        l.cels[i] = makeCel(s, 0, 0, p.width, p.height, bytes);
      });
      setPaletteOf(s, p.palette);
      // Tags outside the frames are skipped; unknown directions stay forward.
      for (const t of p.tags ?? []) {
        if (t.from >= 1 && t.to <= s.durations.length && t.from <= t.to) s.tags.push({ name: t.name, from: t.from, to: t.to, direction: DIRECTIONS[t.direction] ?? "forward" });
      }
      if (p.title) s.title = p.title;
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: l };
      return { frames: s.durations.length, tags: s.tags.length, title: fileTitle(s.title) };
    },
    create_tilemap: (p) => {
      // The map drawn flat on a layer marked tilemap (the fake keeps no tileset).
      const set = decode(p.rgba), t = p.tile;
      if (set.length !== p.width * p.height * 4) throw new Error(`Expected ${p.width * p.height * 4} bytes, got ${set.length}`);
      const rows = p.map.length, cols = p.map[0].length, W = cols * t;
      const cel = new Uint8Array(W * rows * t * 4);
      p.map.forEach((row, y) => row.forEach((i, x) => {
        if (i < 0) return;
        if (i >= p.count) throw unsupported(`tile index ${i} past the tileset (count ${p.count})`);
        const sx = (i % p.columns) * t, sy = Math.floor(i / p.columns) * t;
        for (let r = 0; r < t; r++) for (let c = 0; c < t; c++) {
          if (sx + c >= p.width || sy + r >= p.height) continue;
          const from = ((sy + r) * p.width + sx + c) * 4;
          cel.set(set.subarray(from, from + 4), ((y * t + r) * W + x * t + c) * 4);
        }
      }));
      const s = newSprite({ width: W, height: rows * t, durations: [100], defaultPalette: true });
      const l = { id: nextId++, name: p.title ?? "Terrain", visible: true, group: false, parent: null, tilemap: true, cels: [] };
      l.cels[0] = { x: 0, y: 0, width: W, height: rows * t, data: cel };
      s.layers = [l];
      if (p.title) s.title = p.title;
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: l };
      return { title: p.title ?? "Terrain", tiles: p.count, layer: `L${l.id}` };
    },
    // Every distinct color in the target cels (or the selection), with counts.
    collect_colors: (p) => {
      const s = active.sprite;
      if (s.colorMode === "grayscale") throw unsupported("collect_colors in a grayscale sprite");
      const { layers: ls, frames: fs } = colorTargets(p);
      const counts = new Map();
      let pixels = 0;
      const sel = p.selection && s.selection;
      for (const l of ls) if (l.visible || p.hidden) for (const f of fs) {
        const cel = l.cels[f - 1];
        if (!cel) continue;
        const d = rgbaOf(s, cel);
        for (let y = 0; y < cel.height; y++) for (let x = 0; x < cel.width; x++) {
          const i = (y * cel.width + x) * 4;
          if (!d[i + 3] || (sel && !inSelection(x + cel.x, y + cel.y))) continue;
          const k = hexAt(d, i);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          pixels++;
        }
      }
      return { colors: [...counts].map(([h, count]) => ({ hex: h, count })).sort((a, b) => b.count - a.count), pixels, colorMode: s.colorMode };
    },
    get_palette: () => {
      if (active.sprite.defaultPalette) throw unsupported("the default palette of a new sprite (it comes from Aseprite's preferences)");
      return { colors: active.sprite.palette.map(norm) };
    },
    set_palette: (p) => {
      const s = active.sprite;
      const colors = p.colors;
      if (!colors.length) throw new Error("No colors");
      if (p.append) {
        if (s.defaultPalette) throw unsupported("appending to the default palette of a new sprite");
        // Compared as colors ('#0000FF' is '#0000ff'), each added once.
        const have = new Set(s.palette);
        for (const c of colors.map(norm)) if (!have.has(c)) { have.add(c); s.palette.push(c); }
      } else s.palette = colors.map(norm);
      s.defaultPalette = false;
      return { size: colors.length };
    },
    // Recolors the target cels; indexed sprites change palette entries instead.
    apply_color_map: (p) => {
      const s = active.sprite;
      const map = new Map(Object.entries(p.map).map(([a, b]) => [norm(a), parse(b)]));
      let changed = 0;
      if (s.colorMode === "indexed") {
        s.palette = s.palette.map((c) => {
          const to = map.get(c);
          if (!to) return c;
          changed++;
          return hex(...to);
        });
        return { changed, mode: "palette entries" };
      }
      if (s.colorMode !== "rgb") throw new Error("Recoloring needs an RGB or indexed sprite");
      const { layers: ls, frames: fs } = colorTargets(p);
      for (const l of ls) for (const f of fs) {
        const d = l.cels[f - 1]?.data;
        if (!d) continue;
        for (let i = 0; i < d.length; i += 4) {
          const to = map.get(hexAt(d, i));
          if (to) { d.set(to, i); changed++; }
        }
      }
      return { changed, mode: "pixels" };
    },
    // A swatch strip on the 'AI: <name>' layer (reused when one exists, else new above the active one), in the active frame; it becomes active.
    draw_swatches: (p) => {
      const s = active.sprite, colors = p.colors;
      if (s.colorMode !== "rgb") throw unsupported(`draw_swatches in a ${s.colorMode} sprite`);
      const size = p.size ?? Math.max(1, Math.min(8, Math.floor(s.width / Math.max(1, colors.length))));
      const parsed = colors.map(parse);
      const name = p.name ?? "palette";
      let l = walk(s.layers).find((x) => !x.group && x.name === `AI: ${name}`);
      if (l) active.layer = l;
      else l = aiLayer(name);
      const perRow = Math.max(1, Math.floor(s.width / size));
      const cel = blank();
      parsed.forEach((c, i) => {
        const x0 = (i % perRow) * size, y0 = Math.floor(i / perRow) * size;
        for (let y = y0; y < y0 + size && y < s.height; y++) for (let x = x0; x < x0 + size && x < s.width; x++) cel.set(c, (y * s.width + x) * 4);
      });
      l.cels[active.frame - 1] = { x: 0, y: 0, width: s.width, height: s.height, data: cel };
      return { layer: `L${l.id}` };
    },
    // Copies frames to new ones at the end, flipped (keep_layers unflipped), as a new tag.
    // Existing tags keep their frames and the active frame stays.
    mirror_frames: (p) => {
      const s = active.sprite;
      let fs;
      if (p.tag) {
        fs = s.tags.filter((t) => t.name === p.tag).flatMap((t) => Array.from({ length: t.to - t.from + 1 }, (_, i) => t.from + i));
        if (!fs.length) throw new Error(`No tag named ${p.tag}`);
      } else fs = p.frames ?? s.durations.map((_, i) => i + 1);
      const keep = new Set((p.keep_layers ?? []).map((n) => byRef(n)).filter(Boolean));
      // Every image layer, hidden ones and those in groups included.
      const images = walk(s.layers).filter((l) => !l.group);
      const px = s.colorMode === "indexed" ? 1 : 4;
      let first;
      fs.forEach((f, i) => {
        const nf = s.durations.push(s.durations[f - 1]);
        if (i === 0) first = nf;
        for (const l of images) {
          const c = l.cels[f - 1];
          if (!c) continue;
          if (keep.has(l)) { l.cels[nf - 1] = { ...c, data: new Uint8Array(c.data) }; continue; }
          const out = new Uint8Array(c.data.length);
          for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            const from = (y * c.width + x) * px;
            out.set(c.data.subarray(from, from + px), (y * c.width + (c.width - 1 - x)) * px);
          }
          l.cels[nf - 1] = { x: s.width - (c.x + c.width), y: c.y, width: c.width, height: c.height, data: out };
        }
      });
      if (p.new_tag) s.tags.push({ name: p.new_tag, from: first, to: first + fs.length - 1, direction: "forward" });
      return { from: first, to: first + fs.length - 1, frames: fs.length };
    },
    // One layer per color group, across frames; the rest stays on the source (removed when empty).
    split_layer_by_colors: (p) => {
      const s = active.sprite;
      if (s.colorMode !== "rgb") throw new Error("Splitting by color needs an RGB sprite");
      const src = p.layer !== undefined ? byRef(p.layer) : active.layer;
      if (!src || src.group) throw new Error("Pick an image layer");
      const groupOf = new Map();
      p.groups.forEach((g, gi) => (g.colors ?? []).forEach((h) => groupOf.set(parse(h).slice(0, 3).join(), gi)));
      // Each new layer goes just above the source, so the first group (the outline) ends up on top;
      // sprite:newLayer makes each one active in turn.
      const made = p.groups.map((g) => newLayerAbove(g.name, src));
      if (made.length) active.layer = made.at(-1);
      let leftover = false;
      src.cels.forEach((c, f) => {
        if (!c) return;
        const d = c.data, rest = new Uint8Array(d);
        const parts = [];
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const gi = groupOf.get([d[i], d[i + 1], d[i + 2]].join());
          if (gi === undefined) continue;
          parts[gi] ??= { ...c, data: new Uint8Array(d.length) };
          parts[gi].data.set(d.subarray(i, i + 4), i);
          rest.fill(0, i, i + 4);
        }
        parts.forEach((part, gi) => { if (part) made[gi].cels[f] = part; });
        if (rest.every((v) => v === 0)) src.cels[f] = undefined;
        else { src.cels[f] = { ...c, data: rest }; leftover = true; }
      });
      if (!leftover) detach(src);
      else src.name += " (rest)";
      return { layers: made.map((l) => l.name) };
    },
    // A slice (replacing the first one of the same name). Aseprite lists the newest slice first.
    set_slice: (p) => {
      const s = active.sprite;
      const old = s.slices.findIndex((x) => x.name === p.name);
      if (old >= 0) s.slices.splice(old, 1);
      const c = p.center;
      s.slices.unshift({
        name: p.name ?? "slice",
        bounds: { x: p.x ?? 0, y: p.y ?? 0, width: p.w ?? s.width, height: p.h ?? s.height },
        ...(c ? { center: { x: c.x, y: c.y, width: c.w, height: c.h } } : {}),
      });
      return { slices: s.slices.length };
    },
  };

  // The wire seam (wire_params.lua): params checked against protocol.json, layer
  // references resolved to ids, frame defaults filled in and ranges checked.
  const wire = (method, params) => {
    checkParams(method, params);
    const out = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v;
    const count = active.sprite.durations.length;
    for (const [name, type] of Object.entries(PROTOCOL.requests[method].params ?? {})) {
      const [, base, , fallback] = /^([a-z]+)(\??)([a-z]*)$/.exec(type);
      const v = out[name];
      if (base === "layer" && v !== undefined) {
        const l = byRef(v);
        if (!l) throw new Error(`Layer not found: ${v}`);
        out[name] = `L${l.id}`;
      } else if (base === "frame") {
        if (v === undefined) out[name] = active.frame;
        else if (v < 1 || v > count) throw new Error(`Frame ${v} is out of range (1-${count})`);
      } else if (base === "frames") {
        if (v !== undefined || fallback) out[name] = resolveFrames(v, count, active.frame, fallback || "active");
      }
    }
    return out;
  };

  return {
    calls,
    sprites,
    get active() { return active; },
    /** A layer's pixels in a frame of the active sprite, at sprite size (undefined when it has no cel). */
    cel(name, f = 1) {
      const l = named(active.sprite, name);
      return l?.cels[f - 1] ? layerImage(active.sprite, l, f) : undefined;
    },
    /** A layer's (a layer object or a name) pixels in a frame of any sprite, at sprite size (undefined when it has no cel). */
    image(layer, f = 1, s = active.sprite) {
      const l = typeof layer === "string" ? named(s, layer) : layer;
      return l?.cels[f - 1] ? layerImage(s, l, f) : undefined;
    },
    /** Every frame's pixels of a layer (as image()). */
    images(layer, s = active.sprite) {
      return s.durations.map((_, i) => this.image(layer, i + 1, s));
    },
    /** Root layer names of the active sprite, bottom first. */
    layerNames() { return active.sprite.layers.map((l) => l.name); },
    async request(method, params = {}) {
      calls.push({ method, params });
      const own = extra[method];
      const h = own ?? handlers[method];
      if (!h) throw new Error(`fake document: no handler for ${method}`);
      const r = await h(own || !PROTOCOL.requests[method] ? params : wire(method, params));
      if (Array.isArray(r)) return { result: r[0], binary: r[1] };
      return { result: r };
    },
  };
}

/** A sprite-size RGBA buffer filled with one color inside a rect. */
export function rect(width, height, [x0, y0, x1, y1], [r, g, b, a = 255]) {
  const d = new Uint8Array(width * height * 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d.set([r, g, b, a], (y * width + x) * 4);
  return d;
}

export { hex };
