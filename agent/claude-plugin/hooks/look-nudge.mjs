#!/usr/bin/env node
// PostToolUse hook (#81): after an aseprite tool that edits the document,
// remind the agent once per session to look at the result before it decides
// it is done. The tool list and the text come from the bridge (`npm run gen`
// writes edit-tools.json: every tool of kind "edit" in the Tool table, and
// LOOK_NUDGE from bridge/src/look.ts). One reminder per session, so it stays
// a reminder and not noise. Adapted from aseprite-ai-artist's look-nudge
// (with-pebbly/aseprite-ai-artist, MIT).
//
// Input: the hook JSON on stdin (session_id, tool_name). Output: nothing, or
// hookSpecificOutput.additionalContext. Never fails the tool call.
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const { tools, nudge } = JSON.parse(readFileSync(new URL("./edit-tools.json", import.meta.url), "utf8"));
  // mcp__plugin_aseprite_aseprite__execute_lua -> execute_lua. hooks.json's
  // matcher already narrows the calls; this check keeps the script honest
  // when it runs for another tool.
  const tool = /^mcp__.*aseprite.*__([A-Za-z0-9_-]+)$/.exec(String(input?.tool_name ?? ""))?.[1];
  if (!tool || !tools.includes(tool)) return;

  const session = String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "aseprite-agent-plugin"), "look-nudge");
  const marker = join(dir, session);
  try {
    statSync(marker);
    return; // already reminded in this session
  } catch {}
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
    prune(dir);
  } catch {
    // Without a marker the reminder may repeat; still better than none.
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: nudge } }));
}

/** Removes markers of sessions older than a week. */
function prune(dir) {
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    try {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(file);
    } catch {}
  }
}

try {
  main();
} catch {
  // A broken hook must not get in the way of the edit.
}
