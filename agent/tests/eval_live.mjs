#!/usr/bin/env node
// The skill evals (agent/tests/skills/*.eval.mjs) against the real Aseprite:
// the tool part of the live tests. Each eval's fixture is built in Aseprite,
// its steps run through the bridge's MCP tools, and its check reads what
// Aseprite holds. No model is involved, so a FAIL is a tool or extension bug.
//
//   node agent/tests/eval_live.mjs [skill ...]      (default: every eval)
//   node agent/tests/eval_live.mjs --keep dither    (leave the eval sprites open)
//
// Each eval is written once. Its fixture() still returns the fake document;
// fixtureLua() turns that fake's sprite into Lua that builds the same sprite
// (size, frames and durations, palette, layers bottom first with visibility,
// cels, tags, slices, selection, title, active layer and frame). An eval can
// provide its own `fixtureLua()` (Lua source) when the fake can't describe it.
// liveDocument() gives check() the fake's reading surface (sprites, active,
// cel(name, f), layerNames()) filled from get_state and snapshot.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";
import { imageOf, textOf } from "./mcp_client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EVALS = join(here, "skills");
const MARK = "aseprite-agent-eval";

/** Every eval's skill name, sorted. */
export const evalNames = () => readdirSync(EVALS).filter((f) => f.endsWith(".eval.mjs")).map((f) => f.slice(0, -9)).sort();

export async function loadEval(name) {
  const file = join(EVALS, `${name}.eval.mjs`);
  if (!existsSync(file)) throw new Error(`No eval for skill ${name}`);
  return (await import(pathToFileURL(file).href)).default;
}

/** Why an eval can't run live, or undefined when it can. */
export function liveSkipReason(ev) {
  if (typeof ev.skipLive === "string") return ev.skipLive;
  if (!Array.isArray(ev.steps) || !ev.steps.length || (!ev.fixture && !ev.fixtureLua)) {
    return typeof ev.skip === "string" ? ev.skip : "no fixture or steps";
  }
}

const hexOf = (d) => Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString("hex");
const rgba = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(h);
  if (!m) throw new Error(`Bad color ${h}`);
  return [m[1], m[2], m[3], m[4] ?? "ff"].map((x) => parseInt(x, 16));
};

/**
 * Lua that builds the fake document's active sprite in Aseprite and makes it
 * active, marked as the eval's fixture. Pure: unit-checkable without Aseprite.
 */
export function fixtureLua(fake) {
  const { sprite: s, frame = 1, layer } = fake.active;
  const W = s.width, H = s.height;
  const L = [];
  L.push(`local spr = Sprite(${W}, ${H}, ColorMode.RGB)`);
  L.push(`local function img(h) local i = Image(${W}, ${H}, ColorMode.RGB) i.bytes = (h:gsub("..", function(x) return string.char(tonumber(x, 16)) end)) return i end`);
  for (let f = 2; f <= s.durations.length; f++) L.push("spr:newEmptyFrame()");
  s.durations.forEach((d, i) => L.push(`spr.frames[${i + 1}].duration = ${d / 1000}`));
  if (s.palette?.length) {
    L.push(`local pal = Palette(${s.palette.length})`);
    s.palette.forEach((h, i) => { const [r, g, b, a] = rgba(h); L.push(`pal:setColor(${i}, Color{ r = ${r}, g = ${g}, b = ${b}, a = ${a} })`); });
    L.push("spr:setPalette(pal)");
  }
  // New layers stack on top, so bottom first; the default layer goes at the end.
  L.push("local first = spr.layers[1]", "local L = {}");
  s.layers.forEach((l, i) => {
    L.push(`L[${i + 1}] = ${l.group ? "spr:newGroup()" : "spr:newLayer()"} L[${i + 1}].name = ${JSON.stringify(l.name)}`);
    if (l.visible === false) L.push(`L[${i + 1}].isVisible = false`);
    if (!l.group) l.cels.forEach((d, f) => {
      if (d) L.push(`spr:newCel(L[${i + 1}], ${f + 1}, img("${hexOf(d)}"), Point(0, 0))`);
    });
  });
  if (s.layers.length) L.push("spr:deleteLayer(first)");
  for (const t of s.tags ?? []) L.push(`do local t = spr:newTag(${t.from}, ${t.to}) t.name = ${JSON.stringify(t.name)} end`);
  for (const sl of s.slices ?? []) {
    const b = sl.bounds ?? { x: 0, y: 0, width: W, height: H };
    L.push(`do local sl = spr:newSlice(Rectangle(${b.x}, ${b.y}, ${b.width}, ${b.height})) sl.name = ${JSON.stringify(sl.name ?? "slice")}` +
      (sl.center ? ` sl.center = Rectangle(${sl.center.x}, ${sl.center.y}, ${sl.center.width}, ${sl.center.height})` : "") + " end");
  }
  if (s.selection) L.push(`spr.selection = Selection(Rectangle(${s.selection.x}, ${s.selection.y}, ${s.selection.width}, ${s.selection.height}))`);
  if (s.title) L.push(`spr.filename = ${JSON.stringify(s.title)}`);
  const active = layer ? s.layers.indexOf(layer) : -1;
  if (active >= 0) L.push(`app.layer = L[${active + 1}]`);
  L.push(`app.frame = spr.frames[${frame}]`);
  if (s.colorMode && s.colorMode !== "rgb") L.push(`app.command.ChangePixelFormat{ format = ${JSON.stringify(s.colorMode)} }`);
  L.push(`spr.properties("${MARK}").fixture = true`, "return true");
  return L.join("\n");
}

/** The sprites opened since the fixture (the fixture first, oldest to newest) and which one is active. */
const OPENED = `local j
  for i, s in ipairs(app.sprites) do if s.properties("${MARK}").fixture then j = i break end end
  local active
  for i = 1, (j or 0) do if app.sprites[i] == app.sprite then active = i end end
  return { fixture = j, active = active, count = #app.sprites }`;

/** Layers from get_state (top first, nested) as the fake's flat list, bottom first. */
function flatLayers(list) {
  const out = [];
  for (const l of [...(list ?? [])].reverse()) {
    if (l.group) out.push(...flatLayers(l.layers));
    out.push(l);
  }
  return out;
}

const titleOf = (filename) => basename(String(filename ?? "")).replace(/\.(aseprite|ase|png)$/i, "");

/**
 * What Aseprite holds, in the fake document's shape, for check():
 * { sprites, active: { sprite, frame, layer }, cel(name, f), layerNames() }.
 * Sprites are read eagerly; each one is made active for get_state and snapshot.
 */
export async function liveDocument(c, lua) {
  const o = await lua(OPENED);
  if (!o?.fixture) throw new Error("the eval's fixture sprite is no longer open");
  const sprites = [];
  let active;
  // app.sprites lists the newest first, so the fixture is at o.fixture.
  for (let i = o.fixture; i >= 1; i--) {
    await lua(`app.sprite = app.sprites[${i}] return true`);
    const st = await c.call("get_state");
    if (st.isError) throw new Error(textOf(st));
    const state = JSON.parse(textOf(st));
    const a = state.activeSprite;
    const frames = a.frames.length;
    const layers = [];
    for (const l of flatLayers(a.layers)) {
      const cels = [];
      if (!l.group) for (const f of l.celFrames ?? []) {
        const r = await c.call("snapshot", { layer: l.id, frame: f, scale: 1, background: "transparent" });
        const png = imageOf(r);
        if (r.isError || !png) throw new Error(`snapshot of ${l.name} frame ${f}: ${textOf(r)}`);
        cels[f - 1] = new Uint8Array(PNG.sync.read(png).data);
      }
      cels.length = l.group ? 0 : frames;
      layers.push({ id: l.id, name: l.name, visible: l.visible, group: !!l.group, cels });
    }
    const sprite = {
      title: titleOf(a.filename), width: a.width, height: a.height, colorMode: a.colorMode,
      durations: a.frames.map((f) => f.durationMs),
      palette: a.palette?.colors ?? [],
      tags: (a.tags ?? []).map(({ name, from, to, direction }) => ({ name, from, to, direction })),
      slices: a.slices ?? [],
      selection: a.selection,
      layers,
    };
    sprites.push(sprite);
    if (i === o.active) active = { sprite, frame: state.activeFrame, layer: layers.find((l) => l.id === state.activeLayerId) };
  }
  // Leave the sprite the steps ended on active.
  if (o.active) await lua(`app.sprite = app.sprites[${o.active}] return true`);
  active ??= { sprite: sprites.at(-1), frame: 1, layer: undefined };
  return {
    calls: [],
    sprites,
    active,
    cel(name, f = 1) { return active.sprite.layers.find((l) => l.name === name)?.cels[f - 1]; },
    layerNames() { return active.sprite.layers.map((l) => l.name); },
  };
}

/** Closes the fixture sprite and every sprite opened after it, without saving. */
export const closeEvalSprites = (lua) =>
  lua(`local o = (function() ${OPENED} end)() for i = (o.fixture or 0), 1, -1 do app.sprites[i]:close() end return true`);

/**
 * Runs one eval live. Returns { name, status: "pass" | "fail" | "skip", detail }.
 * c, lua: the live() harness's bridge client and Lua runner.
 */
export async function runEvalLive(name, { c, lua, tools, keep = false }) {
  const ev = await loadEval(name);
  const why = liveSkipReason(ev);
  if (why) return { name, status: "skip", detail: why };
  const missing = ev.steps.map((s) => s.tool).filter((t) => tools && !tools.includes(t));
  if (missing.length) return { name, status: "fail", detail: `the bridge does not expose ${[...new Set(missing)].join(", ")}` };
  let built = false;
  try {
    let code;
    if (ev.fixtureLua) code = await ev.fixtureLua();
    else code = fixtureLua(await ev.fixture());
    await lua(code);
    built = true;
    const results = [];
    for (const [i, s] of ev.steps.entries()) {
      const r = await c.call(s.tool, s.input);
      if (!r || r.isError) return { name, status: "fail", detail: `step ${i + 1} (${s.tool}) failed: ${r ? textOf(r) : "no result"}` };
      results.push(r);
    }
    const doc = await liveDocument(c, lua);
    await ev.check(doc, results, assert);
    return { name, status: "pass" };
  } catch (e) {
    return { name, status: "fail", detail: String(e?.message ?? e).split("\n").slice(0, 6).join("\n") };
  } finally {
    if (built && !keep) await closeEvalSprites(lua).catch(() => {});
  }
}

// Run as a script: PASS/FAIL/SKIP per eval, then the summary line.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { live } = await import("./live.mjs");
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const names = args.filter((a) => !a.startsWith("--"));
  const unknown = names.filter((n) => !evalNames().includes(n));
  if (unknown.length) {
    console.error(`No eval for ${unknown.join(", ")}. Evals: ${evalNames().join(" ")}`);
    process.exit(2);
  }
  const { c, lua, check, done } = await live();
  const tools = await c.listTools();
  let skipped = 0;
  for (const name of names.length ? names : evalNames()) {
    const r = await runEvalLive(name, { c, lua, tools, keep });
    if (r.status === "skip") { console.log(`SKIP eval ${name}: ${r.detail}`); skipped++; continue; }
    check(`eval ${name}`, r.status === "pass", r.detail);
  }
  if (skipped) console.log(`${skipped} evals skipped (no deterministic steps to run live)`);
  done("EVALS");
}
