// Copies agent/guide and the wire protocol definition into the bridge
// package so `npx aseprite-agent` works without the rest of the repository.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "..", "guide");
const dst = join(root, "guide");
if (!existsSync(src)) {
  console.error(`guide not found at ${src}`);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log(`copied guide -> ${dst}`);

// The ase CLI's file mode runs the extension's document handlers headless.
const ext = join(root, "extension");
rmSync(ext, { recursive: true, force: true });
cpSync(join(root, "..", "extension"), ext, {
  recursive: true,
  filter: (p) => !p.includes("__pref") && (p === join(root, "..", "extension") || p.endsWith(".lua") || p.endsWith(".json")),
});
console.log(`copied extension -> ${ext}`);

// The wire protocol definition ships with the extension; the package needs a copy.
cpSync(join(root, "..", "extension", "protocol.json"), join(root, "protocol.json"));
console.log(`copied protocol.json -> ${join(root, "protocol.json")}`);
