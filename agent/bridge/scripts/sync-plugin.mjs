// Keeps the Claude Code plugin (agent/claude-plugin) in step with the bridge:
// the guide topics become skills, the pixel-art rule chapters (guide/rules,
// #77) ride along as files of the aseprite-pixel-art skill (read on demand,
// like the MCP resources rules://<chapter>), and the plugin's version is the bridge's.
// Part of `npm run gen` (scripts/gen.mjs); `node scripts/sync-plugin.mjs --check`
// fails when the committed plugin is out of date.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "..", "claude-plugin");
const guide = join(root, "..", "guide");

const SKILLS = [
  {
    name: "aseprite",
    topic: "basics",
    description:
      "Rules for editing Aseprite through the aseprite MCP tools: workflow, the Lua API pitfalls, layers, cels, " +
      "frames, mentions and timeline text. Use before the first edit in a session that changes a sprite.",
  },
  {
    name: "aseprite-pixel-art",
    topic: "pixel-art",
    description: "Pixel-art style rules and a working loop for drawing and animating in Aseprite with the aseprite MCP tools.",
    suffix: "\nThe rule chapters are also in this skill's `rules/` folder (`rules/animation.md`, ...), for reading without the MCP server.\n",
  },
  {
    name: "aseprite-recipes",
    topic: "recipes",
    description:
      "Tested Lua snippets for common Aseprite tasks (pixelate an image, retime, idle bob, outline, export a sprite sheet) " +
      "to run with the aseprite execute_lua tool.",
  },
];

// Every plugin file this script owns, mapped to its expected contents.
function pluginFiles() {
  const files = new Map();
  for (const s of SKILLS) {
    const body = readFileSync(join(guide, `${s.topic}.md`), "utf8");
    files.set(join(plugin, "skills", s.name, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${body}${s.suffix ?? ""}`);
  }
  // Rule chapters: supporting files of the pixel-art skill, never inlined.
  const rules = join(guide, "rules");
  for (const f of existsSync(rules) ? readdirSync(rules).filter((n) => n.endsWith(".md")).sort() : []) {
    files.set(join(plugin, "skills", "aseprite-pixel-art", "rules", f), readFileSync(join(rules, f), "utf8"));
  }
  // Built-in skills (#35) ship in the plugin too, as aseprite-<name>.
  const builtin = join(root, "..", "skills");
  for (const name of existsSync(builtin) ? readdirSync(builtin) : []) {
    const file = join(builtin, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").replace(/^name: .*$/m, `name: aseprite-${name}`);
    files.set(join(plugin, "skills", `aseprite-${name}`, "SKILL.md"), text);
  }

  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const manifestPath = join(plugin, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  files.set(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  return files;
}

// Writes the plugin files that differ, or with check only lists them.
// Returns the paths that were (or would be) changed.
export function syncPlugin({ check = false } = {}) {
  const stale = [];
  for (const [path, text] of pluginFiles()) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === text) continue;
    stale.push(path);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`updated ${path}`);
    }
  }
  return stale;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = syncPlugin({ check });
  if (check && stale.length) {
    console.error(`The Claude Code plugin is out of date; run npm run gen:\n${stale.join("\n")}`);
    process.exit(1);
  }
}
