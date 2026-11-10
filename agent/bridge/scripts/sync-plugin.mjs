// Keeps the Claude Code plugin (agent/claude-plugin) in step with the bridge:
// the guide topics become skills, and the plugin's version is the bridge's.
// Run by `npm run build`; `node scripts/sync-plugin.mjs --check` fails when
// the committed plugin is out of date.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "..", "claude-plugin");
const guide = join(root, "..", "guide");
const check = process.argv.includes("--check");

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
  },
  {
    name: "aseprite-recipes",
    topic: "recipes",
    description:
      "Tested Lua snippets for common Aseprite tasks (pixelate an image, retime, idle bob, outline, export a sprite sheet) " +
      "to run with the aseprite execute_lua tool.",
  },
];

const files = new Map();
for (const s of SKILLS) {
  const body = readFileSync(join(guide, `${s.topic}.md`), "utf8");
  files.set(join(plugin, "skills", s.name, "SKILL.md"), `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${body}`);
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

let stale = [];
for (const [path, text] of files) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === text) continue;
  if (check) stale.push(path);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`updated ${path}`);
  }
}
if (stale.length) {
  console.error(`The Claude Code plugin is out of date; run npm run build:\n${stale.join("\n")}`);
  process.exit(1);
}
