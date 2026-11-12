# Handoff: the AI agent layer of this Aseprite fork

A short map for a reviewer or the next agent. Terms are defined in `GLOSSARY.md`; per-change reasoning is in `docs/NOTES.md` (newest first); build and test commands are in `docs/BUILD-macos.md`.

## What it is

The fork (`codeyoma/aseprite`, branch `agent`) adds an AI agent that works inside Aseprite. The user talks to it in a docked chat panel. It drives the Claude Code or Codex CLI, which run on the user's own subscription. The agent edits the open sprite through MCP tools. Builds of the fork are never distributed (Aseprite EULA), and nothing is published to npm.

## Shape

```
Aseprite (C++ fork)  ──  Lua extension (agent/extension)  ──WebSocket JSON-RPC──  Node bridge (agent/bridge)  ──ACP──  claude-agent-acp / codex-acp
   docked panel,           chat panel, document handlers,                            ChatRunner, ~83 MCP tools,          (the user's Claude Code /
   textedit, undo          step capture, turns/revert                                image work, skills, critic           Codex login)
```

- **Wire protocol**: `extension/protocol.json` is the single definition (version 34). The bridge's requests to the extension go through `document_handlers.lua`. The panel's calls to the bridge are `chat.*`, `commands.*`, `dev.*`, `skills.list` and `import.animation`. Chat turn requests carry `origin: "chat"`.
- **Bridge** (`bridge/src`, ~10.8k lines of TS):
  - `chat.ts` (ChatRunner: chats run their turns at the same time, events tagged with `chatId`, `ask` for a tool's yes/no question);
  - `acp.ts` and `runtime.ts` (ACP sessions, warm start, a stream fallback);
  - `providers/` (lean sessions: only the aseprite MCP server, #87);
  - `http.ts` and `server.ts` (the MCP endpoint per mode, read-only for Ask/Plan);
  - `tool_modules.ts` (the registry of `*_tools.ts`) and `document.ts` (the typed document facade, shared with a fake for tests);
  - `image.ts` (raster helpers);
  - `critic.ts` and `subagents.ts` (fresh-eyes critic, frame-scoped sub-agents);
  - `headless.ts` (a long-lived `aseprite -b` for batch work).
- **Extension** (`extension`, ~8.4k lines of Lua):
  - `agent.lua` is the entry point; file, shell and socket access stay in it, because Aseprite asks permission per script file.
  - `chat_panel.lua` draws the panel.
  - `chats.lua` holds the chats per sprite, their queues and busy state, and routes a chat's requests to its sprite.
  - `composer.lua` is the draft; `conversation.lua` and `turns.lua` handle the log and reply revert/restore through the undo history.
  - `step_capture.lua` keeps a before/after of every edit.
  - `mascot.lua` and `mascot_mood.lua` draw the mascot and pick its mood from chat events.
  - `attachments.lua` handles images; `document_handlers.lua` and `handlers_*.lua` are the operations.
- **Skills and guide**:
  - `skills/*/SKILL.md` holds 25 skills, served to the chat and as MCP prompts.
  - `guide/` holds the basics, recipes and pixel-art rules. `basics.md` is part of the chat system prompt.

## How to run and test

- **Bridge**: `cd agent/bridge && npm test`, the same command CI runs. It builds, checks that generated files are current, and runs about 400 unit tests against a fake document.
- **Lua**: `agent/tests/run_lua_tests.sh` runs about 25 batch-mode suites in `aseprite -b`. `npm test` warns when `extension/` changed after the last full Lua run.
- **Live**: `node agent/tests/run_live.mjs [--restart] <names>` drives the real app and the real agents (Claude and Codex): about 47 `*_live.mjs` tests, plus skill evals.
- **Benchmarks**: `node agent/tests/run_bench.mjs` runs six skills, then the other provider judges the results blind. Runs are saved in `tests/bench/runs/`.
- After any change to a skill or rule: `npm run gen`. After adding a Lua module: `agent/tools/link_extension.sh`, then restart Aseprite.

## State (2026-11-11)

- Milestones M1–M12 are closed. **M13 "Speed and structure"** is in progress.
  - #87 (lean sessions) is closed.
  - #89, #91, #92 and #94 are closed. #88 is half done: look/check on `execute_lua` and the basics guide in the prompt are in; the declarative apply tool and a smaller core tool set are still open.
  - Still open: #90 (document-scoped requests, which would allow truly parallel chats), #93 (project memory, checkpoints), #95 (native helpers), #96 (wire seam), #97 (FX domain module).
- **Measured** (see the 2026-11-11 notes):
  - Model calls are about 94% of a turn's time.
  - Lean sessions cut each call from about 354k tokens to 17–56k.
  - Benchmark skills got about 30% faster at similar judge scores.

## Where to look hardest in a review

- `chat_panel.lua` and `chats.lua`: parallel chats. Each chat request runs with that chat's sprite made active for the one call (`Panel.handleRequest`), then the user's sprite, frame and layer come back; a request that opens or makes a sprite moves the chat there. Turns of two chats on the same sprite are marked mixed and can't be reverted.
- `acp.ts`: the spare session made at warm start, mode switches, and cancellation.
- `providers/agent_home.ts`: the agent's private Codex home (a symlink to the user's `auth.json`), and the Claude options that load no settings files.
- `step_capture.lua`: the change count from row bytes, and the lazy diff image.
- `handlers_check.lua`: findings only for the 32 most used off-palette colors.
- **Known gaps**:
  - Every tool, including agent-written Lua, acts on the *active* sprite; parallel chats swap it per request (#90), so document-scoped handlers remain open.
  - `generate_image` (#102) spends the user's Codex plan limits; it asks first and runs one job at a time.
  - Windows: the dev instance builds and passes unit, Lua and live tests (2026-11-12, #108); the stable instance (update, launcher, Check for Updates) is not checked there yet (`docs/BUILD-windows.md`).
- Two instances (user's stable, agent's dev) are described in `docs/INSTANCES.md`; tests only touch dev.
