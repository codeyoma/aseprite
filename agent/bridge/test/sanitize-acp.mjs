// Turns a raw ACP recording (ASEPRITE_AGENT_RECORD with the ACP runtime)
// into a committable fixture: keeps the session/update notifications the
// ACP mapper reads, one update object per line, with home paths, account
// details and large tool responses removed.
// Usage: node test/sanitize-acp.mjs <raw.log> <fixture.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [input, output] = process.argv.slice(2);
const home = homedir();
const KEEP = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

function scrub(value) {
  if (typeof value === "string") return value.split(home).join("~").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "user@example.com");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    if (value.type === "image" && typeof value.data === "string") return { ...value, data: "<base64 image>" };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

// Output of the agent's own tools (file reads, shell) can hold private text.
const ownTools = new Set();
function isBridgeTool(u) {
  const name = u._meta?.claudeCode?.toolName ?? u.title ?? "";
  return u.rawInput?.server === "aseprite" || /^(mcp__aseprite__|mcp\.aseprite\.)/.test(name);
}

const out = [];
for (const raw of readFileSync(input, "utf8").split("\n")) {
  const line = raw.replace(/^[<>] /, "").trim();
  if (!line.startsWith("{")) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.method !== "session/update") continue;
  const u = msg.params?.update;
  if (!u || !KEEP.has(u.sessionUpdate)) continue;
  if (u.sessionUpdate === "tool_call" && !isBridgeTool(u)) ownTools.add(u.toolCallId);
  if (ownTools.has(u.toolCallId)) {
    if ("rawOutput" in u) u.rawOutput = "<output>";
    if (u.content) u.content = [];
  }
  // The mapper reads only the tool name from Claude's _meta.
  const name = u._meta?.claudeCode?.toolName;
  const { _meta, ...rest } = u;
  out.push(scrub(name ? { ...rest, _meta: { claudeCode: { toolName: name } } } : rest));
}
writeFileSync(output, out.map((u) => JSON.stringify(u)).join("\n") + "\n");
console.log(`${out.length} updates -> ${output}`);
