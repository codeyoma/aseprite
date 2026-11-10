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

## Chat panel inside Aseprite

**File > Scripts > AI Agent > Open Chat Panel** opens a panel where you type requests, like pen.dev's chat. In this fork it docks inside the main window next to the canvas (dockable script dialogs, see [docs/native-panel.md](docs/native-panel.md)); in stock Aseprite it floats. Choose `claude` or `codex`; the bridge runs that CLI with your own login, shows each tool call as it happens, and keeps the conversation going until you click **New chat**. Every message includes what you have selected (layer, frame, timeline range, pixel selection), so "this layer" and "the selected frames" work.

![chat panel](demos/output/7-chat-panel.png)

If no agent session is running, the panel starts a background bridge (`node agent/bridge/dist/index.js --daemon`) on the first message. Aseprite learns the bridge's location the first time any bridge connects, so run `claude` once from this repository first. Other scripts can use it too: `AsepriteAgent.chat("make it blue")`.

The panel's agent can only use the Aseprite tools: Claude runs with `--tools "" --strict-mcp-config --allowedTools mcp__aseprite`, and Codex gets only the `aseprite` MCP server with its tools pre-approved.

## Demos

Produced by [demos/run_demos.mjs](demos/run_demos.mjs), which calls the same MCP tools an agent uses, against a live Aseprite.

| Request | Result |
|---|---|
| "Turn this image into 64×48 pixel art with 12 colors" ([source](demos/output/source.png)) | ![pixelated](demos/output/1-pixelate.png) |
| "Make a blue ball on a layer called Body, and add a 50% Shadow layer under it" | ![layers](demos/output/2-layers.png) |
| "Add 8 px of canvas on the left, right and top" | ![canvas](demos/output/3-canvas.png) |
| "Make a 6-frame idle bob, tag it `idle`, export a GIF" | ![idle](demos/output/4-idle.gif) |
| "Double the frames (6 → 12) without changing the speed" | 12 frames, still 0.72 s per loop |
| "Export a sprite sheet with JSON" | [6-sheet.png](demos/output/6-sheet.png) + [6-sheet.json](demos/output/6-sheet.json) |
| "Show the grid and onion skin" | UI commands run through `run_command` |

## Setup

1. Install the extension and connect your agent: see [docs/INSTALL.md](docs/INSTALL.md). To build this fork of Aseprite yourself, see [docs/BUILD-macos.md](docs/BUILD-macos.md).
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
| `get_context` | What the user selected: active layer/frame/cel, timeline range, pixel selection, tool and brush |
| `execute_lua` | Runs Lua in Aseprite as one undo step; rolls back on error |
| `run_command` | Runs any of Aseprite's 183 built-in commands with parameters (dialogs skipped by default) |
| `list_commands` | Finds commands and their parameters, generated from this fork's source |
| `snapshot` | PNG of the sprite or a layer, upscaled so pixels are visible |
| `read_pixels` | A region as a text grid with a color legend |
| `read_guide` | Agent guide: `basics`, `recipes`, `pixel-art` (in [guide/](guide/)) |
| `undo` / `redo` | Steps back and forward through the history |

Several agent sessions can run at once. The newest bridge takes over Aseprite; when it exits, the previous one takes it back.

## Security

`execute_lua` runs arbitrary Lua inside Aseprite, which can read and write files. The bridge listens on `127.0.0.1` only and requires a token. Keep Aseprite's script security prompts enabled.

## License

The code under `agent/` is MIT-licensed (see [LICENSE](LICENSE)). Everything else in this repository is Aseprite source under its EULA. Aseprite is a trademark of Igara Studio S.A. and is distributed under its own [EULA](https://github.com/aseprite/aseprite/blob/main/EULA.txt). This project is not affiliated with Igara Studio.
