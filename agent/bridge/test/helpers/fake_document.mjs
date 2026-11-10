// An in-memory sprite behind the AsepriteRequester seam (#52): answers every
// request the document module sends (get_state, snapshot, put_image,
// create_sprite, create_animation, create_tilemap, and the color, palette,
// mirror, split and slice requests) the way the extension's handlers do
// (handlers_color.lua, handlers_sprite.lua), so tool modules run in unit
// tests. Layers hold one RGBA buffer per frame at sprite size.
import { resolveFrames } from "../../dist/document.js";

const hex = (r, g, b, a = 255) => "#" + [r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, "0")).join("");
const hexAt = (d, i) => hex(d[i], d[i + 1], d[i + 2], d[i + 3]);
const parse = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(h);
  if (!m) throw new Error(`Bad color ${h}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) : 255];
};
/** Normalized hex ("#rrggbb", "#rrggbbaa" when not opaque), as the extension writes it. */
const norm = (h) => hex(...parse(h));

/**
 * layers: [{ name, frames: [Uint8Array (w*h*4)], visible?, group? }] (bottom first; a group has no pixels)
 * opts: { width, height, frames, palette: ["#rrggbb"], tags, frame, layer,
 *         colorMode: "rgb" | "indexed" | "grayscale", selection: { x, y, width, height }, slices }
 * extra: request handlers that replace or add to the built-in ones.
 */
export function fakeDocument({
  width, height, frames = 1, layers = [], palette = ["#000000", "#ffffff"], tags = [], frame = 1, layer,
  colorMode = "rgb", selection, slices = [], extra = {},
}) {
  let nextId = 1;
  const sprite = {
    width, height, frames, palette: [...palette], tags: [...tags], colorMode, selection, slices: [...slices],
    durations: Array.from({ length: frames }, () => 100),
    layers: layers.map((l) => ({
      id: nextId++, name: l.name, visible: l.visible !== false, group: !!l.group,
      cels: l.group ? [] : (l.frames ?? []).map((d) => (d ? new Uint8Array(d) : undefined)),
    })),
  };
  const sprites = [sprite];
  let active = { sprite, frame, layer: sprite.layers.find((l) => l.name === (layer ?? sprite.layers.filter((x) => !x.group).at(-1)?.name)) };
  const calls = [];
  const newSprite = (s) => ({ colorMode: "rgb", slices: [], tags: [], ...s });
  const byRef = (ref) => {
    if (ref === undefined || ref === null) return undefined;
    const id = String(ref).replace(/^L/, "");
    return active.sprite.layers.find((l) => String(l.id) === id) ?? active.sprite.layers.find((l) => l.name === ref);
  };
  const blank = () => new Uint8Array(active.sprite.width * active.sprite.height * 4);
  const composite = (f) => {
    const out = blank();
    for (const l of active.sprite.layers) {
      const d = l.visible && l.cels[f - 1];
      if (!d) continue;
      for (let i = 0; i < out.length; i += 4) if (d[i + 3]) out.set(d.subarray(i, i + 4), i);
    }
    return out;
  };
  // The image layers and frames (default all) a color request covers, as colorTargets in handlers_color.lua.
  const colorTargets = (p) => {
    const s = active.sprite;
    let ls;
    if (p.layer !== undefined && p.layer !== null) {
      const l = byRef(p.layer);
      if (!l) throw new Error(`Layer not found: ${p.layer}`);
      ls = l.group ? [] : [l];   // the fake's groups have no children
    } else ls = s.layers.filter((l) => !l.group && l.visible);
    return { layers: ls, frames: resolveFrames(p.frames, s.durations.length, active.frame, "all") };
  };
  const inSelection = (i) => {
    const sel = active.sprite.selection;
    if (!sel) return true;
    const x = (i / 4) % active.sprite.width, y = Math.floor(i / 4 / active.sprite.width);
    return x >= sel.x && y >= sel.y && x < sel.x + sel.width && y < sel.y + sel.height;
  };
  const aiLayer = (name) => {
    const full = `AI: ${name}`;
    let l = active.sprite.layers.find((x) => x.name === full);
    if (!l) {
      l = { id: nextId++, name: full, visible: true, group: false, cels: [] };
      active.sprite.layers.push(l);
    }
    return l;
  };
  const handlers = {
    get_state: () => {
      const s = active.sprite;
      return {
        activeFrame: active.frame,
        activeLayerId: active.layer ? `L${active.layer.id}` : undefined,
        activeSprite: {
          filename: s.title ?? "Sprite", width: s.width, height: s.height, colorMode: s.colorMode,
          frames: s.durations.map((d, i) => ({ frame: i + 1, durationMs: d })),
          // Top layer first, as get_state reports them.
          layers: [...s.layers].reverse().map((l) => ({ id: `L${l.id}`, name: l.name, visible: l.visible, group: l.group, ...(l.group ? { layers: [] } : {}) })),
          tags: s.tags.map((t) => ({ direction: "forward", repeat: 0, ...t })),
          palette: { size: s.palette.length, colors: s.palette },
          selection: s.selection,
          slices: s.slices,
        },
      };
    },
    snapshot: (p) => {
      const f = p.frame ?? active.frame;
      if (f < 1 || f > active.sprite.durations.length) throw new Error(`Frame ${f} is out of range`);
      let data;
      if (p.layer !== undefined) {
        const l = byRef(p.layer);
        if (!l) throw new Error(`Layer not found: ${p.layer}`);
        data = l.cels[f - 1] ? new Uint8Array(l.cels[f - 1]) : blank();
      } else data = composite(f);
      return [{ width: active.sprite.width, height: active.sprite.height, frame: f }, data];
    },
    put_image: (p) => {
      const bytes = new Uint8Array(Buffer.from(p.rgba, "base64"));
      if (bytes.length !== p.width * p.height * 4) throw new Error("bad size");
      let target;
      if (p.new_layer) {
        const name = `AI: ${p.new_layer}`;
        target = active.sprite.layers.find((l) => l.name === name);
        const source = byRef(p.above);
        if (!target) {
          target = { id: nextId++, name, visible: true, group: false, cels: [] };
          const at = source ? active.sprite.layers.indexOf(source) + 1 : active.sprite.layers.length;
          active.sprite.layers.splice(at, 0, target);
        }
        if (p.hide_source && source) source.visible = false;
        if (p.hide) target.visible = false;
      } else {
        target = p.layer !== undefined ? byRef(p.layer) : active.layer;
        if (!target) throw new Error(p.layer !== undefined ? `No layer ${p.layer}` : "No image layer to write to");
      }
      // Place the image at x, y on a sprite-size cel.
      const cel = blank(), W = active.sprite.width;
      for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
        const sx = x + (p.x ?? 0), sy = y + (p.y ?? 0);
        if (sx < 0 || sy < 0 || sx >= W || sy >= active.sprite.height) continue;
        cel.set(bytes.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4), (sy * W + sx) * 4);
      }
      target.cels[(p.frame ?? active.frame) - 1] = cel;
      return { layer: `L${target.id}`, name: target.name };
    },
    create_sprite: (p) => {
      const s = newSprite({ title: p.title ?? "Sprite", width: p.width, height: p.height, durations: [100], palette: p.palette ?? [], layers: [{ id: nextId++, name: "Layer 1", visible: true, group: false, cels: [new Uint8Array(Buffer.from(p.rgba, "base64"))] }] });
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { title: s.title };
    },
    create_animation: (p) => {
      const s = newSprite({
        title: p.title ?? "Animation", width: p.width, height: p.height, palette: p.palette ?? [], tags: p.tags ?? [],
        durations: p.frames.map((f) => f.duration ?? 100),
        layers: [{ id: nextId++, name: "Layer 1", visible: true, group: false, cels: p.frames.map((f) => new Uint8Array(Buffer.from(f.rgba, "base64"))) }],
      });
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { title: s.title, frames: s.durations.length };
    },
    create_tilemap: (p) => {
      // The map drawn flat, plus what the tilemap was made of.
      const set = new Uint8Array(Buffer.from(p.rgba, "base64")), t = p.tile;
      const rows = p.map.length, cols = p.map[0].length, W = cols * t;
      const cel = new Uint8Array(W * rows * t * 4);
      p.map.forEach((row, y) => row.forEach((i, x) => {
        if (i < 0) return;
        const sx = (i % p.columns) * t, sy = Math.floor(i / p.columns) * t;
        for (let r = 0; r < t; r++) cel.set(set.subarray(((sy + r) * p.width + sx) * 4, ((sy + r) * p.width + sx + t) * 4), ((y * t + r) * W + x * t) * 4);
      }));
      const s = newSprite({ title: p.title ?? "Terrain", width: W, height: rows * t, durations: [100], palette: [], tilemap: { tile: t, count: p.count },
        layers: [{ id: nextId++, name: p.title ?? "Terrain", visible: true, group: false, cels: [cel] }] });
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { title: s.title, tiles: p.count, layer: `L${s.layers[0].id}` };
    },
    // Every distinct color in the target cels (or the selection), with counts.
    collect_colors: (p) => {
      const { layers: ls, frames: fs } = colorTargets(p);
      const counts = new Map();
      let pixels = 0;
      for (const l of ls) if (l.visible || p.hidden) for (const f of fs) {
        const d = l.cels[f - 1];
        if (!d) continue;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3] || (p.selection && !inSelection(i))) continue;
          const k = hexAt(d, i);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          pixels++;
        }
      }
      return { colors: [...counts].map(([h, count]) => ({ hex: h, count })).sort((a, b) => b.count - a.count), pixels, colorMode: active.sprite.colorMode };
    },
    get_palette: () => ({ colors: active.sprite.palette.map(norm) }),
    set_palette: (p) => {
      const s = active.sprite;
      const colors = (p.colors ?? []).map(norm);
      if (!colors.length) throw new Error("No colors");
      if (p.append) {
        const have = new Set(s.palette.map(norm));
        s.palette = [...s.palette, ...colors.filter((c) => !have.has(c))];
      } else s.palette = colors;
      return { size: colors.length };
    },
    // Recolors the target cels; indexed sprites change palette entries instead.
    apply_color_map: (p) => {
      const s = active.sprite;
      const map = new Map(Object.entries(p.map ?? {}).map(([a, b]) => [norm(a), parse(b)]));
      let changed = 0;
      if (s.colorMode === "indexed") {
        s.palette = s.palette.map((c) => {
          const to = map.get(norm(c));
          if (!to) return c;
          changed++;
          return hex(...to);
        });
        return { changed, mode: "palette entries" };
      }
      if (s.colorMode !== "rgb") throw new Error("Recoloring needs an RGB or indexed sprite");
      const { layers: ls, frames: fs } = colorTargets(p);
      for (const l of ls) for (const f of fs) {
        const d = l.cels[f - 1];
        if (!d) continue;
        for (let i = 0; i < d.length; i += 4) {
          const to = map.get(hexAt(d, i));
          if (to) { d.set(to, i); changed++; }
        }
      }
      return { changed, mode: "pixels" };
    },
    // A swatch strip on a new 'AI: <name>' layer in the active frame.
    draw_swatches: (p) => {
      const s = active.sprite, colors = p.colors ?? [];
      const size = p.size ?? Math.max(1, Math.min(8, Math.floor(s.width / Math.max(1, colors.length))));
      const l = aiLayer(p.name ?? "palette");
      const perRow = Math.max(1, Math.floor(s.width / size));
      const cel = blank();
      colors.forEach((h, i) => {
        const x0 = (i % perRow) * size, y0 = Math.floor(i / perRow) * size, c = parse(h);
        for (let y = y0; y < y0 + size && y < s.height; y++) for (let x = x0; x < x0 + size && x < s.width; x++) cel.set(c, (y * s.width + x) * 4);
      });
      l.cels[active.frame - 1] = cel;
      active.layer = l;
      return { layer: `L${l.id}` };
    },
    // Copies frames to new ones at the end, flipped (keep_layers unflipped), as a new tag.
    mirror_frames: (p) => {
      const s = active.sprite;
      let fs;
      if (p.tag) {
        fs = s.tags.filter((t) => t.name === p.tag).flatMap((t) => Array.from({ length: t.to - t.from + 1 }, (_, i) => t.from + i));
        if (!fs.length) throw new Error(`No tag named ${p.tag}`);
      } else fs = resolveFrames(p.frames, s.durations.length, active.frame, "all");
      const keep = new Set((p.keep_layers ?? []).map((n) => byRef(n)).filter(Boolean));
      const first = s.durations.length + 1;
      for (const f of fs) {
        const nf = s.durations.length + 1;
        s.durations.push(s.durations[f - 1]);
        for (const l of s.layers) {
          const d = l.cels[f - 1];
          if (l.group || !d) continue;
          if (keep.has(l)) { l.cels[nf - 1] = new Uint8Array(d); continue; }
          const out = new Uint8Array(d.length);
          for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
            out.set(d.subarray((y * s.width + x) * 4, (y * s.width + x) * 4 + 4), (y * s.width + (s.width - 1 - x)) * 4);
          }
          l.cels[nf - 1] = out;
        }
      }
      if (p.new_tag) s.tags.push({ name: p.new_tag, from: first, to: first + fs.length - 1 });
      return { from: first, to: first + fs.length - 1, frames: fs.length };
    },
    // One layer per color group, across frames; the rest stays on the source (removed when empty).
    split_layer_by_colors: (p) => {
      const s = active.sprite;
      if (s.colorMode !== "rgb") throw new Error("Splitting by color needs an RGB sprite");
      const src = p.layer !== undefined && p.layer !== null ? byRef(p.layer) : active.layer;
      if (!src || src.group) throw new Error("Pick an image layer");
      const groupOf = new Map();
      (p.groups ?? []).forEach((g, gi) => (g.colors ?? []).forEach((h) => groupOf.set(parse(h).slice(0, 3).join(), gi)));
      const made = p.groups.map((g) => ({ id: nextId++, name: g.name, visible: true, group: false, cels: [] }));
      let leftover = false;
      src.cels.forEach((d, f) => {
        if (!d) return;
        const rest = new Uint8Array(d);
        let left = false;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const gi = groupOf.get([d[i], d[i + 1], d[i + 2]].join());
          if (gi === undefined) { left = true; continue; }
          made[gi].cels[f] ??= new Uint8Array(d.length);
          made[gi].cels[f].set(d.subarray(i, i + 4), i);
          rest.fill(0, i, i + 4);
        }
        if (left) leftover = true;
        src.cels[f] = left ? rest : undefined;
      });
      // Each new layer goes just above the source, so the first group (the outline) ends up on top.
      s.layers.splice(s.layers.indexOf(src) + 1, 0, ...[...made].reverse());
      if (!leftover) {
        s.layers.splice(s.layers.indexOf(src), 1);
        if (active.layer === src) active.layer = made[0];
      } else src.name += " (rest)";
      return { layers: made.map((l) => l.name) };
    },
    // A slice (replacing one of the same name); bounds default to the sprite.
    set_slice: (p) => {
      const s = active.sprite;
      s.slices = s.slices.filter((x) => x.name !== p.name);
      const c = p.center;
      s.slices.push({
        name: p.name ?? "slice",
        bounds: { x: p.x ?? 0, y: p.y ?? 0, width: p.w ?? s.width, height: p.h ?? s.height },
        ...(c ? { center: { x: c.x, y: c.y, width: c.w, height: c.h } } : {}),
      });
      return { slices: s.slices.length };
    },
    ...extra,
  };
  return {
    calls,
    sprites,
    get active() { return active; },
    /** A layer's pixels in a frame of the active sprite (undefined when empty). */
    cel(name, f = 1) { return active.sprite.layers.find((l) => l.name === name)?.cels[f - 1]; },
    layerNames() { return active.sprite.layers.map((l) => l.name); },
    async request(method, params = {}) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`fake document: no handler for ${method}`);
      const r = await h(params);
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
