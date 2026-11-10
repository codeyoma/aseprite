# Installing Aseprite Agent

Two pieces: the **extension** inside Aseprite, and the **bridge** that your agent (Claude Code or Codex) talks to. They work with stock Aseprite 1.3+ (the chat panel floats) or with this fork (the chat panel docks).

## 1. Install the extension

1. Get `aseprite-agent-<version>.aseprite-extension` from the repository's releases, or build it: `agent/tools/package_extension.sh`.
2. Aseprite: **Edit > Preferences > Extensions > Add Extension**, choose the file, restart Aseprite.
3. The first time a bridge runs, Aseprite asks whether `agent.lua` may read `~/.aseprite-agent/session.json`. Tick **Give full trust to this script** and click **Give Script Full Access**. The extension needs this to find the bridge, open its local connection, and start a background bridge for the chat panel.

## 2. Connect your agent

The bridge runs with Node.js 20 or later.

**Claude Code**

```bash
claude mcp add aseprite -- npx -y aseprite-agent
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.aseprite]
command = "npx"
args = ["-y", "aseprite-agent"]
```

Until the package is on npm, point at a local build instead: `node /path/to/aseprite/agent/bridge/dist/index.js` (build it with `npm install && npm run build` in `agent/bridge`), or install the packed tarball with `npm install -g ./aseprite-agent-<version>.tgz` and use `aseprite-agent` as the command.

Start a session and ask, for example: "Make a 32×32 sprite with a red circle on a layer called Body."

## 3. Chat inside Aseprite

**File > Scripts > AI Agent > Open Chat Panel**. Pick `claude` or `codex` and type a request. The panel uses the CLI you are logged in to; no API key is needed. If no agent session is running, the panel starts a background bridge, which needs to know where the bridge lives: run the agent once with the MCP server (step 2) so Aseprite remembers the path.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Aseprite is not connected" | Open Aseprite. Check **File > Scripts > AI Agent > Connect**. Allow the security prompt. |
| No security prompt and no connection | Aseprite only loads extensions from real folders. If you installed by hand with a symlinked folder, use a real folder (symlinked files inside are fine). |
| Panel says "No bridge found" | Run your agent once with the `aseprite` MCP server so the extension learns the bridge path. |
| Panel says "The bridge did not start" | Read `~/.aseprite-agent/daemon.log`. Usually `node` is not on your login shell's `PATH`. |
| Codex tool calls fail with an approval message | The panel pre-approves the `aseprite` server's tools. In your own Codex sessions, approve them when asked, or set `default_tools_approval_mode = "approve"` under `[mcp_servers.aseprite]`. |
| Chat text looks blurry | Aseprite draws its UI at reduced resolution when **Screen Scaling** is above 100%. Set **Edit > Preferences > General > Screen Scaling = 100%** and **UI Elements Scaling = 200%**: the UI keeps its size and the panel text renders at full resolution. |
| Two agent sessions | The newest bridge takes over Aseprite; when it exits, the previous one reconnects. |

## Security

- The bridge listens on `127.0.0.1` only. The WebSocket requires a per-session token, and connections from web pages (`http(s)` origins) are rejected. The HTTP MCP endpoint for the chat panel requires its own bearer token.
- `execute_lua` runs any Lua inside Aseprite, including code that reads and writes files. Only connect agents you trust, and review what they do in the chat log.
