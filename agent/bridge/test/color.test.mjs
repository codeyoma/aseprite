// Color science and the palette/tone tools (#36, #38).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjust, describeToneDifference, distance, fromOklab, hex, matchPalettes, nearDuplicates, parseHex, quantize, ramps,
  remap, tally, toOklab, toneStats, toOklch,
} from "../dist/color.js";
import { findPalette, knownPalettes, parseGpl } from "../dist/palettes.js";
import { findTool, runTool } from "../dist/tools.js";

const c = (h, count = 1) => ({ ...parseHex(h), count });

test("OKLab round trip and distance", () => {
  for (const h of ["#000000", "#ffffff", "#ff004d", "#29adff", "#7e2553"]) {
    assert.equal(hex(fromOklab(toOklab(parseHex(h)))), h);
  }
  assert.ok(distance(parseHex("#ff0000"), parseHex("#fe0000")) < 0.01);
  assert.ok(distance(parseHex("#000000"), parseHex("#ffffff")) > 0.9);
});

test("quantize keeps an exact palette and reduces a gradient", () => {
  const pico = findPalette("pico-8").colors;
  const exact = quantize(pico.map((x, i) => ({ ...x, count: i + 1 })), 16);
  assert.equal(exact.length, 16);
  assert.deepEqual(new Set(exact.map(hex)), new Set(pico.map(hex)));
  const grad = Array.from({ length: 200 }, (_, i) => ({ r: i, g: 100, b: 255 - i, a: 255, count: 1 }));
  const k = quantize(grad, 8);
  assert.equal(k.length, 8);
  assert.equal(k.reduce((s, x) => s + x.count, 0), 200);
});

test("ramps group hues and order dark to light; neutrals separate", () => {
  const rs = ramps(["#1d2b53", "#29adff", "#83769c", "#000000", "#ffffff", "#5f574f", "#ff004d", "#7e2553"].map(parseHex));
  const neutral = rs.find((r) => r.name === "neutral");
  assert.ok(neutral.colors.map(hex).includes("#000000") && neutral.colors.map(hex).includes("#ffffff"));
  for (const r of rs) {
    const L = r.colors.map((x) => toOklch(x).L);
    assert.deepEqual(L, [...L].sort((a, b) => a - b), `${r.name} ordered`);
  }
});

test("near duplicates and palette matching", () => {
  assert.equal(nearDuplicates(["#ff004d", "#fe014c", "#29adff"].map(parseHex)).length, 1);
  const pico = findPalette("pico-8").colors.map((x) => ({ ...x, count: 10 }));
  const top = matchPalettes(pico, knownPalettes(), 3);
  assert.equal(top[0].name.toLowerCase().replace(/[^a-z0-9]/g, ""), "pico8");
  assert.equal(top[0].coverage, 1);
  assert.ok(knownPalettes().length > 20, "Aseprite's palettes are found");
  assert.equal(parseGpl("GIMP Palette\n#\n  1  2  3\tx\n").length, 1);
});

test("remap: own palette is a no-op; ramps keep their order", () => {
  const pico = findPalette("pico-8").colors;
  const self = remap(pico, pico);
  for (const x of pico) assert.equal(hex(self.get(hex(x))), hex(x));
  // A 5-step blue ramp remapped to PICO-8 stays ordered dark to light.
  const blues = ["#0a1a40", "#1a3070", "#2a50a0", "#4a80d0", "#90c0ff"].map(parseHex);
  const map = remap(blues, pico);
  const L = blues.map((b) => toOklch(map.get(hex(b))).L);
  for (let i = 1; i < L.length; i++) assert.ok(L[i] >= L[i - 1] - 1e-9, `ordered ${L}`);
  for (const b of blues) assert.ok(pico.some((p) => hex(p) === hex(map.get(hex(b)))));
});

test("tone statistics, differences and adjustment", () => {
  const dull = ["#606060", "#707a70", "#808080"].map((h) => c(h, 10));
  const vivid = ["#ff2020", "#20c040", "#2040ff"].map((h) => c(h, 10));
  const d = describeToneDifference(toneStats(vivid), toneStats(dull));
  assert.ok(d.some((x) => /more saturated/.test(x)), d.join());
  const brighter = adjust(parseHex("#404040"), { lightness: 0.2 });
  assert.ok(toOklch(brighter).L > toOklch(parseHex("#404040")).L + 0.15);
  const desat = adjust(parseHex("#ff2020"), { chroma: -1 });
  assert.ok(toOklch(desat).C < 0.01);
});

function fakeAseprite(colors) {
  const calls = [];
  return {
    calls,
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "collect_colors") return { result: { colors: colors.map(([h, n]) => ({ hex: h, count: n })), pixels: 0 } };
      if (method === "get_palette") return { result: { colors: findPalette("pico-8").colors.map(hex) } };
      if (method === "apply_color_map") return { result: { changed: Object.keys(params.map).length * 3, mode: "pixels" } };
      return { result: { ok: true } };
    },
  };
}
const textOf = (r) => r.content.map((x) => x.text).join("\n");

test("palette_from_image: exact palette, ramps, closest palettes, from a PNG file", async () => {
  const pico = findPalette("pico-8").colors;
  const res = await runTool(findTool("palette_from_image"), {}, fakeAseprite(pico.map((x, i) => [hex(x), 100 - i])));
  assert.match(textOf(res), /^the sprite: 16 distinct colors\./);
  assert.match(textOf(res), /Closest among available palettes:\n- PICO-8 \(16 colors\): 100% of pixels match closely/i);

  const dir = mkdtempSync(join(tmpdir(), "pal-"));
  const png = new PNG({ width: 4, height: 1 });
  [[255, 0, 77, 255], [41, 173, 255, 255], [41, 173, 255, 255], [0, 0, 0, 0]].forEach((p, i) => png.data.set(p, i * 4));
  writeFileSync(join(dir, "a.png"), PNG.sync.write(png));
  const gplPath = join(dir, "out.gpl");
  const fromFile = await runTool(findTool("palette_from_image"), { source: "file", path: join(dir, "a.png"), save_gpl: gplPath }, fakeAseprite([]));
  assert.match(textOf(fromFile), /2 distinct colors/);
  assert.equal(parseGpl(readFileSync(gplPath, "utf8")).length, 2);
});

test("remap_to_palette sends one color map; adjust_tone matches a reference", async () => {
  const fake = fakeAseprite([["#fe004c", 10], ["#2aaeff", 5], ["#000000", 1]]);
  const r = await runTool(findTool("remap_to_palette"), { palette: "PICO-8" }, fake);
  const map = fake.calls.find((x) => x.method === "apply_color_map").params.map;
  assert.deepEqual(map, { "#fe004c": "#ff004d", "#2aaeff": "#29adff" });
  assert.match(textOf(r), /Remapped 2 of 3 colors to PICO-8/);
  const unknown = await runTool(findTool("remap_to_palette"), { palette: "nope" }, fake);
  assert.equal(unknown.isError, true);

  const fake2 = fakeAseprite([["#ff2020", 10], ["#20c040", 10]]);
  fake2.request = (orig => async (m, p) => m === "collect_colors" && p.layer === "Ref"
    ? { result: { colors: [{ hex: "#806060", count: 10 }, { hex: "#608060", count: 10 }] } } : orig(m, p))(fake2.request);
  const t = await runTool(findTool("adjust_tone"), { match_to: { source: "layer", layer: "Ref" } }, fake2);
  assert.match(textOf(t), /Before: .*more saturated.*After: the tones match closely/s);
});

test("palette_from_image: min_share, ignore_alpha_below and save formats", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findTool, runTool } = await import("../dist/tools.js");
  const sent = [];
  // 1000 red, 999 blue, 1 stray green, 50 half-transparent yellow.
  const colors = [{ hex: "#ff0000", count: 1000 }, { hex: "#0000ff", count: 999 }, { hex: "#00ff00", count: 1 }, { hex: "#ffff0070", count: 50 }];
  const fake = { async request(m, p) { sent.push([m, p]); return { result: m === "collect_colors" ? { colors } : { ok: true } }; } };
  const dir = mkdtempSync(join(tmpdir(), "pal-"));
  let r = await runTool(findTool("palette_from_image"), { min_share: 0.002, save: join(dir, "p.hex") }, fake);
  assert.match(r.content[0].text, /2 distinct colors \(1 rare color under 0\.2% dropped\)/);
  assert.deepEqual(readFileSync(join(dir, "p.hex"), "utf8").trim().split("\n").sort(), ["0000ff", "ff0000"]);
  r = await runTool(findTool("palette_from_image"), { ignore_alpha_below: 100, save_gpl: join(dir, "p.gpl") }, fake);
  assert.match(r.content[0].text, /4 distinct colors/);
  assert.match(readFileSync(join(dir, "p.gpl"), "utf8"), /^GIMP Palette\nName: p\n/);
  await runTool(findTool("palette_from_image"), { save: join(dir, "p.pal") }, fake);
  const save = sent.find(([m]) => m === "save_palette");
  assert.deepEqual(save[1].path, join(dir, "p.pal"));
  assert.equal(save[1].colors.length, 3);
});
