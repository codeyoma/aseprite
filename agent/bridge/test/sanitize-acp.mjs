// Turns a raw ACP recording (ASEPRITE_AGENT_RECORD with the ACP runtime)
// into committable fixtures:
// - <fixture.jsonl>: the session/update notifications the ACP mapper reads,
//   one update object per line;
// - <fixture>-permission.jsonl (when the agent asked for any): the params of
//   each session/request_permission request, one per line, which
//   acp_permission.test.mjs checks the scripted fake agent against.
// Home paths, user names, account details, tokens and large tool responses
// are removed.
// Usage: node test/sanitize-acp.mjs <raw.log> <fixture.jsonl>
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";

const [input, output] = process.argv.slice(2);
const home = homedir();
const user = (() => { try { return userInfo().username; } catch { return ""; } })();
const KEEP = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

function scrubText(s) {
  s = s.split(home).join("~");
  if (user.length > 2) s = s.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "user");
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "user@example.com")
    .replace(/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1<token>")
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][\w-]{10,}/g, "<token>");
}

function scrub(value) {
  if (typeof value === "string") return scrubText(value);
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

// The mapper reads only the tool name from Claude's _meta.
function slimMeta(u) {
  const name = u._meta?.claudeCode?.toolName;
  const { _meta, ...rest } = u;
  return name ? { ...rest, _meta: { claudeCode: { toolName: name } } } : rest;
}

// A permission request keeps its shape (the keys, the options and their
// kinds); the text an own tool shows (a diff, a file) is replaced.
function permission(params) {
  const { _meta, ...rest } = params;
  const toolCall = slimMeta(params.toolCall ?? {});
  if (!isBridgeTool(toolCall) && Array.isArray(toolCall.content)) {
    toolCall.content = toolCall.content.map((c) => (c?.type === "content" && c.content?.type === "text" ? { ...c, content: { type: "text", text: "<text>" } } : c));
  }
  return scrub({ ...rest, sessionId: "<session>", toolCall });
}

const out = [];
const permissions = [];
for (const raw of readFileSync(input, "utf8").split("\n")) {
  const line = raw.replace(/^[<>] /, "").trim();
  if (!line.startsWith("{")) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.method === "session/request_permission" && msg.params) {
    permissions.push(permission(msg.params));
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
  out.push(scrub(slimMeta(u)));
}
writeFileSync(output, out.map((u) => JSON.stringify(u)).join("\n") + "\n");
console.log(`${out.length} updates -> ${output}`);
if (permissions.length) {
  const permOutput = output.replace(/(\.jsonl)?$/, "-permission.jsonl");
  writeFileSync(permOutput, permissions.map((p) => JSON.stringify(p)).join("\n") + "\n");
  console.log(`${permissions.length} permission requests -> ${permOutput}`);
}
