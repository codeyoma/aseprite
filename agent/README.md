# Aseprite Agent

Control [Aseprite](https://www.aseprite.org/) with natural language through your local coding agent — [Claude Code](https://claude.com/claude-code) or [Codex CLI](https://github.com/openai/codex) — using your own subscription.

> "Make a layer called Shadow under Body."
> "Turn this PNG into 32×32 pixel art with 16 colors."
> "Change this animation from 10 frames to 20."
> "Open the palette editor and switch to the bucket tool."

The agent does not generate images with a diffusion model. It drives Aseprite itself: it calls Aseprite's 183 built-in commands, uses its tools, edits layers, frames, cels, tags and pixels through the Lua API, and looks at snapshots to check its work.

**Status:** early development. See [docs/PLAN.md](docs/PLAN.md).

This directory lives inside a fork of Aseprite. The rest of the repository is Aseprite's own source, under its [EULA](../EULA.txt).

## How it works

```
Claude Code / Codex CLI
        │  MCP (stdio)
        ▼
agent/bridge/  (Node, MCP server)   ── ws://127.0.0.1, per-session token
        │  WebSocket
        ▼
agent/extension/  (Aseprite Lua extension)
  runs each request inside app.transaction → one undo step
```

## Repository layout

| Path | Contents |
|---|---|
| `agent/extension/` | Aseprite extension (Lua). Connects to the bridge and executes requests. |
| `agent/bridge/` | MCP server that Claude Code or Codex connects to. |
| `agent/docs/` | Plan and agent instructions. |

## Requirements

- Aseprite 1.3 or later: build this fork from source for personal use (see [INSTALL.md](../INSTALL.md)), or use a purchased copy with the extension only. Never redistribute compiled binaries.
- Node.js 20 or later.
- Claude Code or Codex CLI.

## Setup

1. Build Aseprite and the bridge, and install the extension: see [docs/BUILD-macos.md](docs/BUILD-macos.md).
2. Connect your agent.
   - **Claude Code:** the repository root has a `.mcp.json` that starts the bridge. Run `claude` from the repository root and approve the `aseprite` server. From another folder:
     ```bash
     claude mcp add aseprite -- node /path/to/aseprite/agent/bridge/dist/index.js
     ```
   - **Codex:** add to `~/.codex/config.toml`:
     ```toml
     [mcp_servers.aseprite]
     command = "node"
     args = ["/path/to/aseprite/agent/bridge/dist/index.js"]
     ```
3. Open Aseprite. The extension connects to the bridge automatically (File > Scripts > AI Agent > Connect / Disconnect).
4. Ask: "Make a 32×32 sprite with a red circle on a layer called Body."

## Tools

| Tool | What it does |
|---|---|
| `get_state` | Open sprites; layers, frames, tags, palette, selection, active tool and colors |
| `execute_lua` | Runs Lua in Aseprite as one undo step; rolls back on error |
| `snapshot` | PNG of the sprite or a layer, upscaled so pixels are visible |
| `undo` / `redo` | Steps back and forward through the history |

## Security

`execute_lua` runs arbitrary Lua inside Aseprite, which can read and write files. The bridge listens on `127.0.0.1` only and requires a token. Keep Aseprite's script security prompts enabled.

## License

The code under `agent/` is MIT-licensed (see [LICENSE](LICENSE)). Everything else in this repository is Aseprite source under its EULA. Aseprite is a trademark of Igara Studio S.A. and is distributed under its own [EULA](https://github.com/aseprite/aseprite/blob/main/EULA.txt). This project is not affiliated with Igara Studio.
