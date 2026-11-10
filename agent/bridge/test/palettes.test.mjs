// Palettes by name and Lospec palettes with credit (#83). No network: a mock
// fetch answers from the fixtures below and the cache lives in a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hex } from "../dist/color.js";
import {
  cleanPaletteName, configureLospec, findPalette, knownPalettes, lospecCacheDir, paletteCredit, resolveNamedPalette,
} from "../dist/palettes.js";
import { findTool, runTool } from "../dist/tools.js";

// Made-up colors in the shape of Lospec's palette API (https://lospec.com/palettes/api).
const FIXTURES = {
  "resurrect-64": { name: "Resurrect 64", author: "Kerrie Lake", colors: ["2e222f", "3e3546", "625565", "966c6c"] },
  "nintendo-gameboy-bgb": { name: "Nintendo Gameboy (bgb)", author: "", colors: ["081820", "346856", "88c070", "e0f8d0"] },
  "endesga-64": { name: "Endesga 64", author: "ENDESGA", colors: ["ff0040", "131313", "1b1b1b", "272727"] },
};

/** Points the Lospec code at a fresh cache and a mock fetch; returns the URLs fetched. */
function mockLospec(t, { offline = false } = {}) {
  const urls = [];
  const restore = configureLospec({
    cacheDir: mkdtempSync(join(tmpdir(), "lospec-")),
    fetch: async (url) => {
      urls.push(url);
      if (offline) throw new Error("getaddrinfo ENOTFOUND lospec.com");
      const slug = /palette-list\/(.+)\.json$/.exec(url)[1];
      const body = FIXTURES[slug];
      return { ok: !!body, status: body ? 200 : 404, json: async () => body ?? { error: "palette not found" } };
    },
  });
  t.after(restore);
  return urls;
}

function fakeAseprite(colors) {
  const calls = [];
  return {
    calls,
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "collect_colors") return { result: { colors: colors.map(([h, n]) => ({ hex: h, count: n })), pixels: 0 } };
      if (method === "apply_color_map") return { result: { changed: Object.keys(params.map).length, mode: "pixels" } };
      return { result: { ok: true } };
    },
  };
}
const textOf = (r) => r.content.map((x) => x.text).join("\n");

test("a Lospec slug is fetched once, cached with its credit, then found offline", async (t) => {
  const urls = mockLospec(t);
  const p = await resolveNamedPalette("resurrect-64");
  assert.equal(p.source, "lospec");
  assert.deepEqual(p.colors.map(hex), ["#2e222f", "#3e3546", "#625565", "#966c6c"]);
  assert.deepEqual(p.credit, { author: "Kerrie Lake", url: "https://lospec.com/palette-list/resurrect-64" });
  assert.deepEqual(urls, ["https://lospec.com/palette-list/resurrect-64.json"]);

  const cached = JSON.parse(readFileSync(join(lospecCacheDir(), "resurrect-64.json"), "utf8"));
  assert.equal(cached.author, "Kerrie Lake");
  assert.equal(cached.url, "https://lospec.com/palette-list/resurrect-64");

  for (const name of ["Resurrect 64", "lospec:resurrect-64", "RESURRECT-64"]) {
    assert.equal((await resolveNamedPalette(name)).slug, "resurrect-64", name);
  }
  assert.equal(findPalette("resurrect 64")?.source, "lospec", "the sync lookup sees the cache");
  assert.equal(urls.length, 1, "later lookups use the cache");
  assert.ok(knownPalettes().some((x) => x.slug === "resurrect-64"), "cached palettes are known palettes");
});

test("aliases: Aseprite's palette when installed, else Lospec; 'lospec:' forces Lospec", async (t) => {
  const urls = mockLospec(t);
  assert.equal(cleanPaletteName("make it Game Boy"), "Game Boy");
  assert.equal(cleanPaletteName("the Endesga 32 palette"), "Endesga 32");
  for (const name of ["Game Boy", "make it Game Boy", "gameboy", "gb"]) {
    const p = await resolveNamedPalette(name);
    assert.equal(p.source, "aseprite", name);
    assert.match(p.name, /^Game ?Boy$/, name);
  }
  for (const name of ["endesga-32", "db32", "nes"]) assert.equal((await resolveNamedPalette(name)).source, "aseprite", name);
  assert.deepEqual(urls, [], "aliases with an Aseprite palette need no network");

  const gb = await resolveNamedPalette("lospec:gameboy");
  assert.equal(gb.slug, "nintendo-gameboy-bgb");
  assert.equal(paletteCredit(gb), "Nintendo Gameboy (bgb) by an unnamed Lospec user (https://lospec.com/palette-list/nintendo-gameboy-bgb)");
  const e64 = await resolveNamedPalette("Endesga 64");
  assert.equal(e64.slug, "endesga-64", "an alias without an Aseprite palette goes to Lospec");
  assert.equal(paletteCredit(e64), "Endesga 64 by ENDESGA (https://lospec.com/palette-list/endesga-64)");
});

test("offline and unknown names give messages that say what to do", async (t) => {
  mockLospec(t, { offline: true });
  await assert.rejects(resolveNamedPalette("lospec:sweetie-16"),
    /Could not reach Lospec for 'sweetie-16' \(getaddrinfo ENOTFOUND lospec\.com\); are you offline\? Use a palette from list_palettes/);
  assert.equal((await resolveNamedPalette("PICO-8")).source, "aseprite", "local palettes still work offline");
});

test("a name Lospec does not have lists the known palettes", async (t) => {
  mockLospec(t);
  await assert.rejects(resolveNamedPalette("no such palette"),
    /No palette named no such palette: not among the user's or Aseprite's palettes, and Lospec has no 'no-such' \(https:\/\/lospec\.com\/palette-list\/no-such\)\. Known: .*DB32.*lospec:endesga-32/);
});

test("list_palettes shows Lospec palettes with author and URL, and the aliases", async (t) => {
  mockLospec(t);
  await resolveNamedPalette("resurrect-64");
  const all = textOf(await runTool(findTool("list_palettes"), {}, fakeAseprite([])));
  assert.match(all, /^Resolution order: 'lospec:<slug>' goes to Lospec only/);
  assert.match(all, /Aseprite's:\n(- .*\n)*- PICO-8 \(16 colors\)/);
  assert.match(all, /Lospec \(cached\):\n- lospec:resurrect-64: Resurrect 64 by Kerrie Lake \(https:\/\/lospec\.com\/palette-list\/resurrect-64\), 4 colors/);
  assert.match(all, /Aliases: gameboy -> GameBoy \(Aseprite\), else lospec:nintendo-gameboy-bgb;/);
  const only = textOf(await runTool(findTool("list_palettes"), { source: "lospec", search: "kerrie" }, fakeAseprite([])));
  assert.doesNotMatch(only, /Aseprite's:/);
  assert.match(only, /lospec:resurrect-64/);
});

test("remap_to_palette and palette_from_image find Lospec palettes by name and credit them", async (t) => {
  const urls = mockLospec(t);
  const fake = fakeAseprite([["#2f232f", 10], ["#977070", 5]]);
  const r = textOf(await runTool(findTool("remap_to_palette"), { palette: "lospec:resurrect-64" }, fake));
  assert.match(r, /Remapped 2 of 2 colors to Resurrect 64/);
  assert.match(r, /\nPalette: Resurrect 64 by Kerrie Lake \(https:\/\/lospec\.com\/palette-list\/resurrect-64\), from Lospec\./);
  assert.deepEqual(fake.calls.find((c) => c.method === "apply_color_map").params.map, { "#2f232f": "#2e222f", "#977070": "#966c6c" });

  const local = textOf(await runTool(findTool("remap_to_palette"), { palette: "Game Boy" }, fakeAseprite([["#0f380f", 1]])));
  assert.doesNotMatch(local, /Lospec/, "Aseprite's palettes carry no Lospec credit");

  const px = fakeAseprite([["#081820", 40], ["#346856", 30], ["#88c070", 20], ["#e0f8d0", 10]]);
  const out = textOf(await runTool(findTool("palette_from_image"), { compare_with: ["lospec:gameboy", "resurrect-64"] }, px));
  assert.match(out, /- Nintendo Gameboy \(bgb\) by an unnamed Lospec user \(https:\/\/lospec\.com\/palette-list\/nintendo-gameboy-bgb\) \(4 colors\): 100% of pixels match closely/);
  assert.match(out, /Resurrect 64 by Kerrie Lake/);
  assert.equal(urls.filter((u) => u.includes("resurrect-64")).length, 1, "resurrect-64 came from the cache the second time");
});
