// The agent guide (agent/guide/*.md): bundled in the npm package (../guide),
// or read from the repository (../../guide).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GUIDE_DIR =
  [new URL("../guide/", import.meta.url), new URL("../../guide/", import.meta.url)]
    .map((u) => fileURLToPath(u))
    .find((dir) => existsSync(dir)) ?? fileURLToPath(new URL("../guide/", import.meta.url));

export function guideTopics(): string[] {
  try {
    return readdirSync(GUIDE_DIR).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** The topic's markdown, or undefined for an unknown topic. */
export function readGuide(topic: string): string | undefined {
  const key = topic.toLowerCase().replace(/\.md$/, "");
  if (!guideTopics().includes(key)) return undefined;
  return readFileSync(`${GUIDE_DIR}${key}.md`, "utf8");
}
