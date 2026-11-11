// Lean agent sessions (#87): the agent gets only what an Aseprite turn
// needs. The user's own Claude Code / Codex setup (other MCP servers,
// plugins, hooks, skills, project memory) would otherwise ride along on every
// model call: measured at 503 tools and ~350k tokens per call, 81 of the
// tools being Aseprite's.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionDir } from "../session.js";

/** Top-level Codex settings carried over from the user's config: model choice and service tier only. */
export const CODEX_KEPT_KEYS = ["model", "model_provider", "model_context_window", "model_auto_compact_token_limit",
  "model_reasoning_effort", "model_reasoning_summary", "service_tier", "model_verbosity"];

/**
 * The agent's Codex config: the kept top-level keys of the user's config.toml
 * (everything before the first [table]), nothing else: no MCP servers,
 * plugins, notify hooks or marketplaces. ASEPRITE_AGENT_CODEX_EFFORT overrides
 * the reasoning effort (an xhigh default makes every turn slow).
 */
export function leanCodexConfig(userToml: string, effort = process.env.ASEPRITE_AGENT_CODEX_EFFORT): string {
  const out: string[] = [];
  for (const line of userToml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (m && CODEX_KEPT_KEYS.includes(m[1]) && !(effort && m[1] === "model_reasoning_effort")) out.push(line.trim());
  }
  if (effort) out.push(`model_reasoning_effort = ${JSON.stringify(effort)}`);
  return out.join("\n") + "\n";
}

/**
 * A private CODEX_HOME for the agent: the user's auth (linked, so a login
 * refresh is shared) and the lean config. Rebuilt on every start.
 */
export function agentCodexHome(userHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"), dir = join(sessionDir, "codex-home")): string {
  mkdirSync(dir, { recursive: true });
  const auth = join(userHome, "auth.json"), link = join(dir, "auth.json");
  rmSync(link, { force: true });
  if (existsSync(auth)) {
    // A link keeps a login refresh shared; Windows needs admin rights for one, so it gets a copy.
    try {
      symlinkSync(auth, link);
    } catch {
      copyFileSync(auth, link);
    }
  }
  const userConfig = join(userHome, "config.toml");
  writeFileSync(join(dir, "config.toml"), leanCodexConfig(existsSync(userConfig) ? readFileSync(userConfig, "utf8") : ""));
  return dir;
}

/**
 * Claude Code options for a lean session: no settings files (so no user
 * hooks, plugins, skills or CLAUDE.md), only the MCP servers the session
 * passes (the aseprite one), and no claude.ai connectors.
 */
export const LEAN_CLAUDE_OPTIONS = {
  settingSources: [] as string[],
  strictMcpConfig: true,
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
};
