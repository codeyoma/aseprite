// Known palettes for "closest palette" and remapping (#36, #83): the user's
// own in ~/.aseprite-agent/palettes (.gpl or .hex), the palettes Aseprite
// ships (data/extensions/*-palette(s), GIMP .gpl files), and Lospec palettes
// fetched by slug on demand and cached in ~/.aseprite-agent/palettes/lospec
// with their name, author and URL. Nothing is bundled by us: Lospec's terms
// give no licence to redistribute user-submitted palettes, and its API is
// meant for fetching one palette a user asked for. ASEPRITE_AGENT_PALETTES
// adds a folder.
//
// Resolution order of a name (resolveNamedPalette):
//   1. "lospec:<slug or alias>" goes to Lospec only (cache, then network).
//   2. The user's palettes, then Aseprite's, by name (case, spaces, dashes ignored).
//   3. An alias ("gameboy", "nes", "db32", "endesga-32", ...): its Aseprite
//      equivalent when installed, else its Lospec slug.
//   4. Cached Lospec palettes, by slug or title.
//   5. Lospec by slug (the name lowercased with dashes), fetched and cached.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { hex, parseHex, type RGBA } from "./color.js";
import { repoRoot } from "./developer.js";
import { sessionDir } from "./session.js";
import { installedAsepriteData } from "./platform.js";

export interface PaletteCredit {
  author: string; // "" when Lospec has no author name
  url: string;
}

export interface NamedPalette {
  name: string;
  colors: RGBA[];
  source: string; // "user", "aseprite" or "lospec"
  slug?: string; // Lospec only
  credit?: PaletteCredit; // Lospec only
}

export function parseGpl(text: string): RGBA[] {
  const out: RGBA[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s|$)/.exec(line);
    if (m) out.push({ r: +m[1], g: +m[2], b: +m[3], a: 255 });
  }
  return out;
}

export function parsePaletteFile(path: string): RGBA[] {
  const text = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".gpl") return parseGpl(text);
  return text.split(/\r?\n/).map((l) => parseHex(l)).filter((c): c is RGBA => !!c);
}

export function asepriteExtensionDirs(): string[] {
  const root = repoRoot();
  return [
    root && join(root, "data", "extensions"),
    ...installedAsepriteData().map((d) => join(d, "extensions")),
    process.env.ASEPRITE_DATA && join(process.env.ASEPRITE_DATA, "extensions"),
  ].filter((d): d is string => !!d && existsSync(d));
}

export function userPaletteDir(): string {
  return join(sessionDir, "palettes");
}

// --- Lospec -----------------------------------------------------------------

export const LOSPEC_URL = "https://lospec.com/palette-list";

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const lospec: { fetch: Fetch; cacheDir: string | undefined; timeoutMs: number } = {
  fetch: (url, init) => {
    // npm test sets this, so no test reaches the network; users can set it too.
    if (process.env.ASEPRITE_AGENT_OFFLINE) return Promise.reject(new Error("network disabled by ASEPRITE_AGENT_OFFLINE"));
    return fetch(url, init);
  },
  cacheDir: undefined,
  timeoutMs: 10000,
};

/** Where fetched Lospec palettes are cached: ~/.aseprite-agent/palettes/lospec/<slug>.json. */
export function lospecCacheDir(): string {
  return lospec.cacheDir ?? join(userPaletteDir(), "lospec");
}

/** Tests swap the network and the cache folder; returns a function that restores them. */
export function configureLospec(opts: { fetch?: Fetch; cacheDir?: string; timeoutMs?: number }): () => void {
  const saved = { ...lospec };
  Object.assign(lospec, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
  cache = undefined;
  return () => {
    Object.assign(lospec, saved);
    cache = undefined;
  };
}

/**
 * Common names for Lospec palettes. `local` is the same palette as Aseprite
 * ships it (used when installed, so these work offline); `slug` is Lospec's.
 */
export const PALETTE_ALIASES: { names: string[]; slug: string; local?: string }[] = [
  { names: ["gameboy", "game boy", "gb", "dmg"], slug: "nintendo-gameboy-bgb", local: "GameBoy" },
  { names: ["pico-8", "pico8"], slug: "pico-8", local: "PICO-8" },
  { names: ["nes", "famicom"], slug: "nintendo-entertainment-system", local: "NES" },
  { names: ["db32", "dawnbringer-32"], slug: "dawnbringer-32", local: "DB32" },
  { names: ["db16", "dawnbringer-16"], slug: "dawnbringer-16", local: "DB16" },
  { names: ["endesga-32", "edg32"], slug: "endesga-32", local: "EDG32" },
  { names: ["endesga-16", "edg16"], slug: "endesga-16", local: "EDG16" },
  { names: ["endesga-64", "edg64"], slug: "endesga-64" },
  { names: ["aap-64"], slug: "aap-64", local: "AAP-64" },
  { names: ["c64", "commodore-64"], slug: "commodore64", local: "Commodore64" },
  { names: ["zx-spectrum", "spectrum"], slug: "zx-spectrum", local: "ZXSpectrum" },
  { names: ["resurrect-64"], slug: "resurrect-64" },
  { names: ["sweetie-16"], slug: "sweetie-16" },
  { names: ["apollo"], slug: "apollo" },
  { names: ["lospec500", "lospec-500"], slug: "lospec500" },
  { names: ["demichrome", "2bit-demichrome"], slug: "2bit-demichrome" },
];

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

function aliasFor(name: string) {
  return PALETTE_ALIASES.find((a) => a.names.some((n) => norm(n) === norm(name)));
}

/** "Endesga 32" -> "endesga-32": the shape of a Lospec slug. */
export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "make it Game Boy", "the Game Boy palette" -> "Game Boy"; "lospec:x" is kept. */
export function cleanPaletteName(spec: string): string {
  return spec.trim()
    .replace(/^(?:make it|use)\s+/i, "")
    .replace(/^(?:the|a)\s+/i, "")
    .replace(/\s+(?:palette|colou?rs)$/i, "")
    .trim();
}

interface CachedLospec {
  slug: string;
  name: string;
  author: string;
  url: string;
  colors: string[];
  fetched: string;
}

function lospecPalette(c: CachedLospec): NamedPalette {
  return {
    name: c.name,
    colors: c.colors.map((h) => parseHex(h)).filter((x): x is RGBA => !!x),
    source: "lospec",
    slug: c.slug,
    credit: { author: c.author, url: c.url },
  };
}

function readCachedLospec(): NamedPalette[] {
  const dir = lospecCacheDir();
  if (!existsSync(dir)) return [];
  const out: NamedPalette[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const p = lospecPalette(JSON.parse(readFileSync(join(dir, f), "utf8")) as CachedLospec);
      if (p.colors.length) out.push(p);
    } catch {
      // a broken cache file is skipped; the next fetch rewrites it
    }
  }
  return out;
}

/** An error whose message the tools show as is. */
export class PaletteError extends Error {}

/** Fetches one palette by slug from Lospec's palette API and caches it with its credit. */
export async function fetchLospecPalette(slug: string): Promise<NamedPalette | undefined> {
  const url = `${LOSPEC_URL}/${slug}`;
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await lospec.fetch(`${url}.json`, {
      signal: AbortSignal.timeout(lospec.timeoutMs),
      headers: { "user-agent": "aseprite-agent (https://github.com/codeyoma/aseprite)" },
    });
  } catch (e) {
    throw new PaletteError(
      `Could not reach Lospec for '${slug}' (${(e as Error).message}); are you offline? ` +
      `Use a palette from list_palettes (Aseprite's and the user's work offline, and Lospec ones fetched before are cached), ` +
      `or pass colors or a .gpl/.hex file.`);
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new PaletteError(`Lospec answered ${res.status} for '${slug}' (${url}). Try again later, or pass colors or a .gpl/.hex file.`);
  const body = (await res.json().catch(() => undefined)) as { name?: unknown; author?: unknown; colors?: unknown } | undefined;
  const colors = Array.isArray(body?.colors) ? body!.colors.filter((c): c is string => typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c)) : [];
  if (!body || typeof body.name !== "string" || !colors.length || colors.length > 256) {
    throw new PaletteError(`Lospec's answer for '${slug}' is not a palette (${url}.json).`);
  }
  const entry: CachedLospec = {
    slug,
    name: body.name.trim() || slug,
    author: typeof body.author === "string" ? body.author.trim() : "",
    url,
    colors: colors.map((c) => `#${c.replace(/^#/, "").toLowerCase()}`),
    fetched: new Date().toISOString(),
  };
  const dir = lospecCacheDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(entry, null, 2) + "\n");
  cache = undefined;
  return lospecPalette(entry);
}

/** "Endesga 32 by ENDESGA (https://lospec.com/palette-list/endesga-32)"; just the name for non-Lospec palettes. */
export function paletteCredit(p: Pick<NamedPalette, "name" | "credit">): string {
  if (!p.credit) return p.name;
  return `${p.name} by ${p.credit.author || "an unnamed Lospec user"} (${p.credit.url})`;
}

// --- Known palettes ---------------------------------------------------------

let cache: NamedPalette[] | undefined;

/** Every available palette, user's first, then Aseprite's, then cached Lospec ones (first found wins per name). */
export function knownPalettes(refresh = false): NamedPalette[] {
  if (cache && !refresh) return cache;
  const byName = new Map<string, NamedPalette>();
  const add = (name: string, colors: RGBA[], source: string) => {
    const key = name.toLowerCase();
    if (colors.length && !byName.has(key)) byName.set(key, { name, colors, source });
  };
  for (const dir of [process.env.ASEPRITE_AGENT_PALETTES, userPaletteDir()].filter((d): d is string => !!d && existsSync(d))) {
    for (const f of readdirSync(dir)) {
      if (/\.(gpl|hex|txt)$/i.test(f)) add(basename(f, extname(f)), parsePaletteFile(join(dir, f)), "user");
    }
  }
  for (const dir of asepriteExtensionDirs()) {
    for (const ext of readdirSync(dir)) {
      const pkgFile = join(dir, ext, "package.json");
      if (!existsSync(pkgFile)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
        for (const p of pkg.contributes?.palettes ?? []) {
          const file = join(dir, ext, p.path);
          if (existsSync(file)) add(p.id ?? basename(file, extname(file)), parsePaletteFile(file), "aseprite");
        }
      } catch {
        // not a palette extension
      }
    }
  }
  // Lospec palettes are keyed by slug, so "PICO-8" from Lospec never hides Aseprite's.
  for (const p of readCachedLospec()) if (!byName.has(`lospec:${p.slug}`)) byName.set(`lospec:${p.slug}`, p);
  cache = [...byName.values()];
  return cache;
}

function findLocal(name: string): NamedPalette | undefined {
  return knownPalettes().find((p) => p.source !== "lospec" && norm(p.name) === norm(name));
}

function findCachedLospec(name: string): NamedPalette | undefined {
  const slug = aliasFor(name)?.slug ?? toSlug(name);
  const lospecs = knownPalettes().filter((p) => p.source === "lospec");
  return lospecs.find((p) => p.slug === slug) ?? lospecs.find((p) => norm(p.name) === norm(name));
}

/**
 * A palette by name without the network: steps 1-4 of the resolution order
 * (user, Aseprite, alias, cached Lospec). "pico-8" = "PICO8".
 */
export function findPalette(spec: string): NamedPalette | undefined {
  const name = cleanPaletteName(spec);
  const forced = /^lospec:/i.exec(name);
  if (forced) return findCachedLospec(name.slice(forced[0].length).trim());
  const alias = aliasFor(name);
  return findLocal(name) ?? (alias?.local ? findLocal(alias.local) : undefined) ?? findCachedLospec(name);
}

/** A palette by name, fetching from Lospec when nothing local or cached has it (the full resolution order). */
export async function resolveNamedPalette(spec: string): Promise<NamedPalette> {
  const found = findPalette(spec);
  if (found) return found;
  const name = cleanPaletteName(spec);
  const bare = name.replace(/^lospec:/i, "").trim();
  const slug = aliasFor(bare)?.slug ?? toSlug(bare);
  if (slug) {
    const fetched = await fetchLospecPalette(slug);
    if (fetched) return fetched;
  }
  const known = knownPalettes().filter((p) => p.source !== "lospec").map((p) => p.name);
  throw new PaletteError(
    `No palette named ${spec}: not among the user's or Aseprite's palettes, and Lospec has no '${slug}' ` +
    `(${LOSPEC_URL}/${slug}). Known: ${known.slice(0, 40).join(", ")}…; Lospec slugs are in the palette's URL (e.g. 'lospec:endesga-32').`);
}

/** The palette's colors as hex, for output. */
export function paletteHex(p: NamedPalette): string[] {
  return p.colors.map(hex);
}
