# Aseprite Agent — Plan

Goal: control Aseprite with natural language through a local coding agent (Claude Code or Codex CLI), using the user's own subscription. The agent plans, calls tools, and edits the open sprite live — similar to how pen.dev (Pencil) works.

Examples the agent should handle:

- "Make a layer called Shadow under Body."
- "Change the canvas to 64×64."
- "Turn this PNG into 32×32 pixel art with 16 colors."
- "Make a 6-frame idle bob animation and tag it `idle`."
- "Change this animation from 10 frames to 20."
- "Open the palette editor / show the timeline / switch to the bucket tool."

## Repository and licensing

This work lives in a fork of `aseprite/aseprite` (`codeyoma/aseprite`), on the `agent` branch. All agent code sits under `agent/` so upstream changes merge cleanly. C++ changes (for example a built-in, dockable chat panel) go into `src/` as needed.

Aseprite's source is under a EULA, not an open-source license:

- Section 2(g): *"You may only compile and modify the source code of the SOFTWARE PRODUCT for your own personal purpose or to propose a contribution to the SOFTWARE PRODUCT."*
- Section 2(b): copies may not be distributed to third parties.

Rules for this fork:

- Never publish compiled binaries of the modified Aseprite.
- Treat C++ changes as personal use or as proposals for upstream contribution.
- Keep the extension (`agent/extension`) and bridge (`agent/bridge`) self-contained, so they can also be released separately under MIT and used with a stock Aseprite.

## What the AI can reach (verified against the API)

- **All 183 built-in commands** via `app.command.<Name>{...}` — menus, dialogs, filters, and panels: `NewLayer`, `CanvasSize`, `SpriteSize`, `ColorQuantization`, `ChangePixelFormat`, `NewFrame`, `NewFrameTag`, `ReverseFrames`, `Outline`, `ReplaceColor`, `ExportSpriteSheet`, `Timeline`, `PaletteEditor`, `PlayAnimation`, `ShowGrid`, `ShowOnionSkin`, `SymmetryMode`, `GotoFrame`, and more. Source: `src/app/commands/commands_list.h`.
- **Tools and drawing**: `app.tool` (pencil, bucket, line, ellipse, …), `app.useTool{}` to simulate strokes, `app.fgColor` / `app.bgColor`, `app.brush`.
- **Document model**: `Sprite`, `Layer`, `Frame`, `Cel`, `Tag`, `Palette`, `Image` (direct pixel access), `Selection`, `Slice`, `Tileset`.
- **User context**: `app.site`, `app.range` (selected layers/frames/cels in the timeline), `sprite.selection`, `app.editor`.
- **Undo safety**: `app.transaction(fn)` groups each agent action into one undo step.
- **Networking**: `WebSocket` client class (Aseprite ≥ 1.3) to talk to the local bridge.

## Architecture

```
Claude Code / Codex CLI
        │  MCP (stdio)
        ▼
aseprite-agent bridge (Node)          ── ws://127.0.0.1:<port>, random token
        │  WebSocket (JSON-RPC)
        ▼
Aseprite extension (Lua)
  - runs requests inside app.transaction
  - returns results, state, PNG snapshots
  - later: chat panel (Dialog) that streams agent events
```

### MCP tools (v1)

| Tool | Purpose |
|---|---|
| `get_state` | Open sprites, size, color mode, layers tree, frames + durations, tags, palette, active tool/colors |
| `get_context` | What the user has selected: active layer/frame/cel, timeline range, pixel selection bounds |
| `execute_lua` | Run Lua inside Aseprite in one transaction; returns printed output / returned value / error |
| `run_command` | Call `app.command.<Name>` with params (typed shortcut for the 183 commands) |
| `list_commands` | Names + known params for discovery |
| `snapshot` | PNG of the sprite / a frame / a layer, upscaled nearest-neighbor, so the agent can see results |
| `read_pixels` | Region as a palette-index or hex grid for precise edits |
| `undo` / `redo` | Roll back an agent step |

### Agent knowledge

A skill / instructions file shipped with the project:

- Aseprite Lua API cheat sheet and gotchas (1-based frames, cel vs. image, indexed vs. RGB, `app.transaction`).
- Recipes: pixelate image, retime frames, add tag, onion-skin-friendly animation, sprite sheet export.
- Pixel-art rules: limited palette, shading ramps, outlines, no stray anti-aliasing, snapshot-and-fix loop.

## Milestones

1. **M0 — Fork + skeleton.** Fork Aseprite, `agent` branch, extension `package.json`, bridge package.
2. **M1 — Bridge works.** Extension connects over WebSocket; `get_state`, `execute_lua`, `snapshot` work from Claude Code.
3. **M2 — Full tool set.** `run_command`, `list_commands`, `get_context`, `read_pixels`, `undo`. Skill doc with recipes.
4. **M3 — Demo set.** Pixelate a PNG; create layers; retime 10 → 20 frames; idle bob animation; export sprite sheet.
5. **M4 — In-app chat panel.** Lua `Dialog` with prompt box and streamed event log; bridge spawns `claude -p --output-format stream-json` (or `codex exec --json`) with the MCP config, and sends the current selection as context.
6. **M5 — Packaging.** `.aseprite-extension` release, `npx aseprite-agent` bridge, setup docs for Claude Code and Codex.

## Security notes

- Bridge listens on `127.0.0.1` only, with a per-session token.
- `execute_lua` runs arbitrary code in Aseprite, which can touch files (`io`, `os`). Aseprite's own script security prompts stay on; the README must state this.

## Open questions

- Is Aseprite installed locally for testing? (Not found in `/Applications` or Steam.)
- Chat panel inside Aseprite (basic) vs. companion window (rich) for M4.
