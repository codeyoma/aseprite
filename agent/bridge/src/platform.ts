// What differs between macOS, Windows and Linux, in one place: finding a
// program on PATH (no shell), executable names, and where an installed
// Aseprite keeps its program and data.
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** A program's file name on this platform ("aseprite" -> "aseprite.exe" on Windows). */
export const exe = (name: string) => (IS_WINDOWS ? `${name}.exe` : name);

/**
 * The full path of a command on PATH, or undefined. Scans PATH itself (with PATHEXT on Windows: .exe, .cmd, ...), so
 * it needs no shell.
 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = IS_WINDOWS ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try {
        if (existsSync(file) && statSync(file).isFile()) return file;
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return undefined;
}

/** Folders where an installed Aseprite keeps its program (newest guesses last). */
export function installedAsepriteBins(): string[] {
  if (process.platform === "darwin") return ["/Applications/Aseprite.app/Contents/MacOS/aseprite"];
  if (IS_WINDOWS) {
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
    return [
      ...pf.map((p) => join(p, "Aseprite", "Aseprite.exe")),
      ...pf.map((p) => join(p, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe")),
    ];
  }
  return ["/usr/bin/aseprite", "/usr/local/bin/aseprite"];
}

/** An installed Aseprite's data folder (extensions, fonts, palettes), if one is found. */
export function installedAsepriteData(): string[] {
  if (process.platform === "darwin") return ["/Applications/Aseprite.app/Contents/Resources/data"];
  return installedAsepriteBins().map((bin) => join(bin, "..", "data"));
}
