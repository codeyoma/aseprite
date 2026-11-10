// Copies agent/guide into the bridge package so `npx aseprite-agent` can
// serve read_guide without the rest of the repository.
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
