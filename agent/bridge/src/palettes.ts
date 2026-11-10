// Known palettes for "closest palette" and remapping (#36): the palettes
// Aseprite ships (data/extensions/*-palette(s), GIMP .gpl files) and the
// user's own in ~/.aseprite-agent/palettes (.gpl or .hex). Nothing is
// bundled by us; ASEPRITE_AGENT_PALETTES adds a folder.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseHex, type RGBA } from "./color.js";
import { repoRoot } from "./developer.js";
import { sessionDir } from "./session.js";

export interface NamedPalette {
  name: string;
  colors: RGBA[];
  source: string; // "aseprite" or "user"
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
    "/Applications/Aseprite.app/Contents/Resources/data/extensions",
    process.env.ASEPRITE_DATA && join(process.env.ASEPRITE_DATA, "extensions"),
  ].filter((d): d is string => !!d && existsSync(d));
}

export function userPaletteDir(): string {
  return join(sessionDir, "palettes");
}

let cache: NamedPalette[] | undefined;

/** Every available palette (first found wins per name). */
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
  cache = [...byName.values()];
  return cache;
}

/** A palette by name, ignoring case, spaces and dashes ("pico-8" = "PICO8"). */
export function findPalette(name: string): NamedPalette | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  return knownPalettes().find((p) => norm(p.name) === norm(name));
}
