// Turns a raw CLI recording (ASEPRITE_AGENT_RECORD) into a committable
// fixture: keeps only the events the provider adapters read, drops shell
// commands and config warnings, replaces image data and scrubs home paths.
// Usage: node test/sanitize-recording.mjs claude|codex <raw.jsonl> <fixture.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const [provider, input, output] = process.argv.slice(2);
const home = homedir();

function scrub(value) {
  if (typeof value === "string") return value.split(home).join("~");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    if (value.type === "image" && typeof value.data === "string") return { ...value, data: "<base64 image>" };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

function keep(ev) {
  if (provider === "claude") {
    if (ev.type === "system" && ev.subtype === "init") return { type: "system", subtype: "init", session_id: ev.session_id };
    if (ev.type === "assistant" || ev.type === "user") {
      return { type: ev.type, session_id: ev.session_id, message: { content: ev.message?.content ?? [] } };
    }
    if (ev.type === "result") {
      return { type: "result", subtype: ev.subtype, is_error: ev.is_error, result: ev.result, session_id: ev.session_id };
    }
    return null;
  }
  // codex
  const itemType = ev.item?.type;
  if (ev.type === "thread.started" || ev.type === "turn.started" || ev.type === "turn.completed") return { type: ev.type, thread_id: ev.thread_id };
  if ((ev.type === "item.started" || ev.type === "item.completed") && ["agent_message", "reasoning", "mcp_tool_call"].includes(itemType)) return ev;
  if (ev.type === "error" || ev.type === "turn.failed") return ev;
  return null;
}

const lines = readFileSync(input, "utf8").split("\n").filter((l) => l.trim());
const kept = lines.map((l) => keep(JSON.parse(l))).filter(Boolean).map((ev) => JSON.stringify(scrub(ev)));
writeFileSync(output, kept.join("\n") + "\n");
console.log(`${kept.length} of ${lines.length} events -> ${output}`);
