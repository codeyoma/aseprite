// An in-memory sprite behind the AsepriteRequester seam (#52): answers the
// requests the document module sends (get_state, snapshot, put_image,
// create_sprite, create_animation) so tool modules run in unit tests.
// Layers hold one RGBA buffer per frame at sprite size.

const hex = (r, g, b, a = 255) => "#" + [r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * layers: [{ name, frames: [Uint8Array (w*h*4)] , group?: string }] (bottom first)
 * opts: { width, height, frames, palette: ["#rrggbb"], tags, frame, layer }
 */
export function fakeDocument({ width, height, frames = 1, layers = [], palette = ["#000000", "#ffffff"], tags = [], frame = 1, layer, extra = {} }) {
  let nextId = 1;
  const sprite = {
    width, height, frames, palette, tags,
    durations: Array.from({ length: frames }, () => 100),
    layers: layers.map((l) => ({ id: nextId++, name: l.name, visible: l.visible !== false, cels: l.frames.map((d) => (d ? new Uint8Array(d) : undefined)) })),
  };
  const sprites = [sprite];
  let active = { sprite, frame, layer: sprite.layers.find((l) => l.name === (layer ?? sprite.layers.at(-1)?.name)) };
  const calls = [];
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
  const handlers = {
    get_state: () => {
      const s = active.sprite;
      return {
        activeFrame: active.frame,
        activeLayerId: active.layer ? `L${active.layer.id}` : undefined,
        activeSprite: {
          filename: s.title ?? "Sprite", width: s.width, height: s.height,
          frames: s.durations.map((d, i) => ({ frame: i + 1, durationMs: d })),
          // Top layer first, as get_state reports them.
          layers: [...s.layers].reverse().map((l) => ({ id: `L${l.id}`, name: l.name, visible: l.visible, group: false })),
          tags: s.tags.map((t) => ({ direction: "forward", repeat: 0, ...t })),
          palette: { size: s.palette.length, colors: s.palette },
          selection: s.selection,
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
          target = { id: nextId++, name, visible: true, cels: [] };
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
      const s = { title: p.title ?? "Sprite", width: p.width, height: p.height, durations: [100], palette: p.palette ?? [], tags: [], layers: [{ id: nextId++, name: "Layer 1", visible: true, cels: [new Uint8Array(Buffer.from(p.rgba, "base64"))] }] };
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { title: s.title };
    },
    create_animation: (p) => {
      const s = {
        title: p.title ?? "Animation", width: p.width, height: p.height, palette: p.palette ?? [], tags: p.tags ?? [],
        durations: p.frames.map((f) => f.duration ?? 100),
        layers: [{ id: nextId++, name: "Layer 1", visible: true, cels: p.frames.map((f) => new Uint8Array(Buffer.from(f.rgba, "base64"))) }],
      };
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
      const s = { title: p.title ?? "Terrain", width: W, height: rows * t, durations: [100], palette: [], tags: [], tilemap: { tile: t, count: p.count },
        layers: [{ id: nextId++, name: p.title ?? "Terrain", visible: true, cels: [cel] }] };
      sprites.push(s);
      active = { sprite: s, frame: 1, layer: s.layers[0] };
      return { title: s.title, tiles: p.count, layer: `L${s.layers[0].id}` };
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
