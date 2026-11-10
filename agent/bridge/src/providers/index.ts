import type { AgentProvider, ProviderId } from "./agent_provider.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export * from "./agent_provider.js";

export const PROVIDERS: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export function providerFor(id: string | undefined): AgentProvider {
  return id === "codex" ? codexProvider : claudeProvider;
}
