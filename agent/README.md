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

Click the **AI** button at the top right (left of the workspace layout button), or use **File > Scripts > AI Agent > Toggle Chat Panel**. In this fork the panel docks next to the canvas (see [docs/native-panel.md](docs/native-panel.md)); in stock Aseprite it floats.

Your messages appear as bubbles on the right. Each agent turn shows its steps the way Claude Code does: "Thought for 3s", one row per tool call with a check mark when it succeeds, the reply, and "Worked for 14s". Click a row to see the tool's input and output; an edit step also shows Before, After and changed-pixel thumbnails of the active frame. The input box wraps and grows up to five lines; **Enter** sends and **Shift+Enter** adds a line. Text uses the system font, and Korean and other input methods compose normally. For sharp text, use Screen Scaling 100% with UI Elements Scaling 200% (see [INSTALL.md](docs/INSTALL.md#troubleshooting)).

Choose `claude` or `codex`; the bridge runs that agent with your own login over the [Agent Client Protocol](https://agentclientprotocol.com) (`claude-agent-acp`, `codex-acp`, installed with the bridge) and keeps the conversation going until you click **New chat**. **Stop** cancels the turn and the next message continues the same conversation. When the agent makes a plan, the panel shows it as a checklist; when it asks permission for a tool, the panel asks you. Set `ASEPRITE_AGENT_RUNTIME=stream` to use the older `claude -p` / `codex exec` runtime. Every message includes what you have selected (layer, frame, timeline range, pixel selection), so "this layer" and "the selected frames" work.

The agent puts what it draws on a new `AI: <task>` layer above your layer, with your request saved on it, so your pixels stay untouched unless you ask to edit a layer in place. Ask for variations ("give me 3 swords") and the panel shows a thumbnail of each: click one to keep it as an `AI:` layer, or **Discard** them all. Each choice is one undo step.

When the agent does something you want again, ask it to "save this as a command called outline-dark". Saved commands appear in **File > Scripts > AI Agent > My Commands** and run without the agent; in the chat, `/outline-dark width=2` runs one directly (type `/` to list them). **Manage My Commands...** runs, disables, shows the source of, or reverts a command to its previous version. Commands live in `~/.aseprite-agent/commands`, a git repository with one commit per change.

Type `/` in the chat to search skills: built-in ones (shade and outline, recreate from a reference image, import a sprite sheet, fix AI or upscaled pixel art, extract palette, match tone and palette, check and fix pixel art, retime an animation, variations, work on many frames at once, with more coming in milestone M8) and your own, plus your saved commands. Typing filters the list; click a row or press Enter to pick the top one, then write your request. The reply's header names the skill.

Teach the agent your own techniques with skills: markdown files in `~/.aseprite-agent/skills/` (**File > Scripts > AI Agent > New Skill...** creates one from a template). A skill can list trigger words in its frontmatter; when a message contains one, the skill goes along with it. Type `/skill:name your request` to use a skill explicitly. A skill named like a built-in guide topic (`basics`, `recipes`, `pixel-art`) replaces it for the agent.

```markdown
---
name: dithering
description: Ordered dithering for 16-color sprites
triggers: [dither, gradient, shading]
---
Use a 2x2 Bayer pattern. Never dither single pixels.
```

Pick a mode next to the agent: **Agent** (default) makes changes; **Ask** only answers and advises; **Plan** replies with a numbered plan and an **Apply plan** button that carries it out in Agent mode. Ask and Plan runs connect to a read-only tool endpoint, so the agent cannot change the document. The panel remembers the mode.

**Developer** mode (asks once before the first use) lets the agent change this Aseprite fork itself: it works in the repository with its coding tools, asks you before edits and commands, and commits on a `dev/<date>-<task>` branch. Its reply gets **Rebuild & Relaunch**: Aseprite is rebuilt when C++ changed (build errors go back to the agent to fix) and restarted with your open sprites and the conversation; **Discard** stashes uncommitted changes and returns to the branch you were on. Builds of the fork are for your own use only (Aseprite EULA).

To show the agent something, click **+** and attach the selection, the active layer, the active frame or an image file (for example a reference whose palette or style you want). **File > Scripts > AI Agent** and the timeline's cel, layer and frame context menus have **Attach to AI Chat** too. Attachments are listed above the input and go with your next message as images; rendered ones are saved in `~/.aseprite-agent/attachments` and deleted after a week.

![chat panel](demos/output/7-chat-panel.png)

If no agent session is running, the panel starts a background bridge (`node agent/bridge/dist/index.js --daemon`) on the first message. Aseprite learns the bridge's location the first time any bridge connects, so run `claude` once from this repository first. Other scripts can use it too: `AsepriteAgent.chat("make it blue")`.

The panel's agent can only use the Aseprite tools: Claude runs with no built-in tools and only `mcp__aseprite` allowed, and Codex gets only the `aseprite` MCP server with its tools pre-approved.

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
   - **Claude Code, any folder:** install the plugin (tools plus the guide as skills, see [claude-plugin/](claude-plugin/)):
     ```
     /plugin install aseprite --marketplace codeyoma/aseprite
     ```
   - **Claude Code, this repository:** the repository root has a `.mcp.json` that starts the bridge. Run `claude` from the repository root and approve the `aseprite` server. Or add it by hand:
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

## Command line

`ase` (the bridge package's second command) uses the same tools from a shell. Live commands talk to the running Aseprite; `check` and `render` on a file run Aseprite headless.

```bash
ase state --json
ase snapshot --frame 3 -o frame3.png
ase run -e 'return #app.sprite.layers'
ase timeline
ase check hero.aseprite          # exits 1 when there are errors
ase render hero.aseprite --sheet hero.png --data hero.json
```

Every command takes `--json`. Failures print `✗ <problem>` and `Fix: <what to do>` and exit 1. Set `ASEPRITE_BIN` if `aseprite` isn't on PATH.

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
| `save_command` / `run_saved_command` / `list_saved_commands` / `delete_saved_command` | Keep Lua the agent wrote as a command in **My Commands**, versioned with git |
| `get_timeline_text` / `apply_timeline_text` | The timeline (frames, durations, tags, linked cels) as editable text, applied in one undo step or previewed as a plan |
| `palette_from_image` | Colors of an image, layer, selection or the sprite: counts, ramps, near-duplicates, closest available palettes; set, swatch or save as `.gpl` |
| `color_stats` / `adjust_tone` / `remap_to_palette` | Compare tone in plain words, shift or match lightness/saturation/contrast, or limit colors to a palette (ramps keep their order) |
| `detect_pixel_grid` / `fix_pixel_art` | Find the pixel grid of upscaled or AI-generated "pixel art" (fractional cells too) and rebuild it as a native-size sprite with a clean palette |
| `import_sheet` | Slices a sprite sheet into an animated sprite: a grid (cell size found from the gutters), loose sprites on a background, or an Aseprite/TexturePacker atlas; rows can become tags |
| `recreate_from_reference` / `style_summary` / `split_by_color` | Rebuild an attached screenshot or sprite as an editable sprite (native pixels, palette, frames, layers by color role), and describe a style with rules for drawing new art like it |
| `make_ramp` / `shade_sprite` / `outline_sprite` | Hue-shifted color ramps; shade flat colors from a light direction onto an `AI: shaded` layer; outer/inner outlines in one color, the darkest, or selout |
| `spawn_agents` | Splits a multi-frame job across up to 4 sub-agents running in parallel, each limited to its frames (and layers) |
| `propose_variations` | Shows the user the candidates the agent built (`variationLayer`) as thumbnails to keep one or discard |
| `diff_visual` | What changed on the active frame since the last edit step or a saved checkpoint: PNG with changed pixels in red, bounds and count |
| `check` | Pixel-art checks (off-palette, orphans, semi-transparent, empty cels, frame timing, outside canvas) with fixes |
| `read_guide` | Agent guide: `basics`, `recipes`, `pixel-art` (in [guide/](guide/)), plus your own skills |
| `undo` / `redo` | Steps back and forward through the history |

Several agent sessions can run at once. The newest bridge takes over Aseprite; when it exits, the previous one takes it back.

## Security

`execute_lua` runs arbitrary Lua inside Aseprite, which can read and write files. The bridge listens on `127.0.0.1` only and requires a token. Keep Aseprite's script security prompts enabled.

## License

The code under `agent/` is MIT-licensed (see [LICENSE](LICENSE)). Everything else in this repository is Aseprite source under its EULA. Aseprite is a trademark of Igara Studio S.A. and is distributed under its own [EULA](https://github.com/aseprite/aseprite/blob/main/EULA.txt). This project is not affiliated with Igara Studio.
