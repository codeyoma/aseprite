// Replays the document contract scenarios (agent/tests/contract/*.json)
// against the fake document. agent/tests/contract_test.lua replays the same
// scenarios against the extension's handlers in a headless Aseprite, so the
// fake answers the way Aseprite does. Typed results (get_state: State) are
// checked against protocol.json by the fake itself, as the bridge's link does. The format is in contract/legend.json.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fakeDocument } from "./helpers/fake_document.mjs";
import { checkBridgeParams } from "../dist/protocol.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/contract");
const { legend: LEGEND } = JSON.parse(readFileSync(join(DIR, "legend.json"), "utf8"));
const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "legend.json").sort();

const parse = (h) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(h);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) : 255];
};
const hexOf = (d, i) => "#" + [d[i], d[i + 1], d[i + 2], ...(d[i + 3] < 255 ? [d[i + 3]] : [])].map((v) => v.toString(16).padStart(2, "0")).join("");

/** Pixel rows to { width, height, data } (RGBA). */
function rowsToImage(rows, legend) {
  const height = rows.length, width = rows[0].length;
  const data = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === ".") return;
    const h = legend[ch];
    if (!h) throw new Error(`no legend entry for '${ch}'`);
    data.set(parse(h), (y * width + x) * 4);
  }));
  return { width, height, data };
}

/** RGBA to pixel rows ('?' for a color the legend lacks). */
function imageToRows(data, width, height, legend) {
  const keyOf = new Map(Object.entries(legend).map(([k, h]) => [h.toLowerCase(), k]));
  const rows = [], unknown = new Set();
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!data[i + 3]) { row += "."; continue; }
      const h = hexOf(data, i);
      const k = keyOf.get(h);
      if (!k) unknown.add(h);
      row += k ?? "?";
    }
    rows.push(row);
  }
  return { rows, unknown: [...unknown] };
}

/** The fixture as fakeDocument options (layers bottom first). */
function fixtureOptions(fx, legend) {
  const durations = fx.durations ?? [100];
  const layers = (list) => [...list].reverse().map((l) => ({
    name: l.name, visible: l.visible !== false, group: !!l.group,
    ...(l.group ? { layers: layers(l.layers ?? []) } : {
      frames: durations.map((_, i) => {
        const c = l.cels?.[String(i + 1)];
        if (!c) return undefined;
        const rows = Array.isArray(c) ? c : c.rows;
        const img = rowsToImage(rows, legend);
        return { x: c.x ?? 0, y: c.y ?? 0, width: img.width, height: img.height, data: img.data };
      }),
    }),
  }));
  const firstImage = (list) => {
    for (const l of list) {
      if (!l.group) return l.name;
      const n = firstImage(l.layers ?? []);
      if (n) return n;
    }
  };
  return {
    title: fx.title, width: fx.width, height: fx.height, colorMode: fx.colorMode ?? "rgb", durations,
    palette: fx.palette ?? ["#000000", "#ffffff"],
    layers: layers(fx.layers ?? []),
    tags: (fx.tags ?? []).map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
    slices: (fx.slices ?? []).map((s) => ({
      name: s.name, bounds: { x: s.x, y: s.y, width: s.w, height: s.h },
      ...(s.center ? { center: { x: s.center.x, y: s.center.y, width: s.center.w, height: s.center.h } } : {}),
    })),
    selection: fx.selection ? { x: fx.selection.x, y: fx.selection.y, width: fx.selection.w, height: fx.selection.h } : undefined,
    layer: fx.activeLayer ?? firstImage(fx.layers ?? []),
    frame: fx.activeFrame ?? 1,
  };
}

// Every layer of a get_state tree, top first.
const flat = (layers, out = []) => {
  for (const l of layers ?? []) { out.push(l); if (l.group) flat(l.layers, out); }
  return out;
};

/** get_state, normalized as in legend.json (the Lua runner builds the same). */
function normalize(st) {
  const s = st.activeSprite;
  const layers = (list) => (list ?? []).map((l) => ({
    name: l.name, visible: l.visible, editable: l.editable, group: !!l.group,
    ...(l.group ? { layers: layers(l.layers) } : { cels: l.celFrames ?? [], links: l.celLinks ?? [], tilemap: !!l.tilemap, opacity: l.opacity, blendMode: l.blendMode, fx: l.fx }),
  }));
  return {
    title: s.filename, width: s.width, height: s.height, colorMode: s.colorMode,
    durations: s.frames.map((f) => f.durationMs),
    activeFrame: st.activeFrame,
    activeLayer: flat(s.layers).find((l) => l.id === st.activeLayerId)?.name,
    layers: layers(s.layers),
    tags: (s.tags ?? []).map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
    palette: s.palette?.colors ?? [],
    slices: s.slices ?? [],
    selection: s.selection,
    hits: s.fxHits ?? [],
    pixelSpec: s.pixelSpec,
  };
}

/** Partial match (see legend.json); returns a list of mismatches. */
function match(want, got, ids, path = "$", out = []) {
  const fail = (msg) => out.push(`${path}: ${msg}`);
  if (want && typeof want === "object" && !Array.isArray(want)) {
    if ("$absent" in want) { if (got !== undefined && got !== null) fail(`expected nothing, got ${JSON.stringify(got)}`); return out; }
    if ("$layerId" in want) {
      const id = ids(want.$layerId);
      if (got !== id) fail(`expected the id of '${want.$layerId}' (${id}), got ${JSON.stringify(got)}`);
      return out;
    }
    if ("$set" in want) {
      if (!Array.isArray(got) || got.length !== want.$set.length) { fail(`expected ${want.$set.length} items in any order, got ${JSON.stringify(got)}`); return out; }
      const left = [...got];
      for (const w of want.$set) {
        const i = left.findIndex((g) => match(w, g, ids).length === 0);
        if (i < 0) fail(`no item matches ${JSON.stringify(w)} in ${JSON.stringify(got)}`);
        else left.splice(i, 1);
      }
      return out;
    }
    if (!got || typeof got !== "object" || Array.isArray(got)) { fail(`expected an object, got ${JSON.stringify(got)}`); return out; }
    for (const [k, v] of Object.entries(want)) match(v, got[k], ids, `${path}.${k}`, out);
    return out;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) { fail(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); return out; }
    want.forEach((w, i) => match(w, got[i], ids, `${path}[${i}]`, out));
    return out;
  }
  if (want !== got) fail(`expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  return out;
}

for (const file of files) {
  const { scenarios } = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  for (const sc of scenarios) {
    test(`contract ${file.replace(/\.json$/, "")}: ${sc.name}`, async () => {
      const legend = { ...LEGEND, ...sc.legend };
      const fake = fakeDocument(fixtureOptions(sc.fixture, legend));
      // routed (#90): another sprite becomes the active tab and every step names the fixture sprite.
      let route;
      if (sc.routed) {
        route = { doc: (await fake.request("get_state", {})).result.activeSprite.id };
        await fake.request("create_sprite", { width: 2, height: 2, rgba: Buffer.alloc(16).toString("base64"), title: "other" });
      }
      const state = async () => (await fake.request("get_state", {}, undefined, route)).result;
      const idsIn = (st) => (name) => flat(st.activeSprite.layers).find((l) => l.name === name)?.id;
      // Params with rgba { rows } encoded and { $id } resolved.
      const prepare = async (v, key) => {
        if (Array.isArray(v)) return Promise.all(v.map((x) => prepare(x)));
        if (!v || typeof v !== "object") return v;
        if ("$id" in v) return idsIn(await state())(v.$id);
        if (key === "rgba" && "rows" in v) return Buffer.from(rowsToImage(v.rows, legend).data).toString("base64");
        const out = {};
        for (const [k, x] of Object.entries(v)) out[k] = await prepare(x, k);
        return out;
      };
      for (const [n, step] of sc.steps.entries()) {
        const where = `step ${n + 1}`;
        // A bridge method's params, checked as the bridge checks them on arrival (#96); the Lua runner checks the
        // same step with wire_params.lua.
        if (step.bridgeMethod) {
          const run = () => checkBridgeParams(step.bridgeMethod, step.params ?? {});
          if (step.error) assert.throws(run, (e) => e.message.includes(step.error), `${where}: expected an error containing '${step.error}'`);
          else assert.doesNotThrow(run, `${where} (${step.bridgeMethod})`);
          continue;
        }
        let method, params;
        if (step.request) { method = step.request; params = await prepare(step.params ?? {}); }
        else if (step.pixels) { method = "snapshot"; params = await prepare(step.pixels); }
        else { method = "get_state"; params = {}; }
        let reply, error;
        try { reply = await fake.request(method, params, undefined, route); } catch (e) { error = e; }
        if (step.fakeUnsupported) {
          assert.match(String(error?.message), /^fake document: .* not supported/, `${where}: the fake should refuse (${step.fakeUnsupported})`);
          return;   // what follows depends on what Aseprite did here
        }
        if (step.error) {
          assert.ok(error, `${where}: expected an error containing '${step.error}', got ${JSON.stringify(reply?.result)}`);
          assert.ok(error.message.includes(step.error), `${where}: expected an error containing '${step.error}', got '${error.message}'`);
          continue;
        }
        if (error) throw new Error(`${where} (${method}): ${error.message}`, { cause: error });
        const ids = idsIn(await state());
        let problems = [];
        if (step.request && step.result) problems = match(step.result, reply.result, ids);
        else if (step.pixels) {
          const { rows, unknown } = imageToRows(reply.binary, reply.result.width, reply.result.height, legend);
          problems = match(step.rows, rows, ids);
          if (unknown.length) problems.push(`colors without a legend key: ${unknown.join(", ")}`);
        } else if (step.state) problems = match(step.state, normalize(reply.result), ids);
        assert.deepEqual(problems, [], `${where} (${method})`);
      }
      if (sc.routed) assert.equal((await fake.request("get_state", {})).result.activeSprite.filename, "other", "the other sprite stays active");
    });
  }
}
