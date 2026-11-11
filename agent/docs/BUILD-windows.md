# Building and checking this fork on Windows

For a person, or an agent session on a Windows PC, setting up both instances (`docs/INSTANCES.md`) and checking that
the agent layer works there. Never distribute the build: the Aseprite EULA allows compiling only for personal use or
to propose contributions.

## Tools

- Visual Studio 2022 (Community is enough), workload "Desktop development with C++", including the Windows SDK.
- CMake 3.24 or later and Ninja, both on PATH.
- Git and Node.js 22 (with npm), both on PATH.
- The Claude Code and/or Codex CLI, signed in (`claude`, `codex`), for the chat.

## The user's stable instance

From a clone of `codeyoma/aseprite` (any branch: the stable source is a separate worktree):

```bat
git clone --recursive https://github.com/codeyoma/aseprite.git
cd aseprite
node agent\tools\stable.mjs update
node agent\tools\stable.mjs launcher
```

- `update` builds Aseprite from the `stable` branch in `%USERPROFILE%\.aseprite-agent-stable` (through `build.cmd --auto`, which downloads Skia; the first build takes a while), builds the bridge, copies the extension into `%APPDATA%\Aseprite\extensions\aseprite-agent`, and records the bridge in `%USERPROFILE%\.aseprite-agent\bridge.json`.
- `launcher` adds "Aseprite AI" to the Start menu.
- On first start, Aseprite asks whether `agent.lua` may read files and open sockets: tick "Give full trust to this script".

## The agent's dev instance

```bat
build.cmd --auto --norun
cd agent\bridge && npm ci && npm test && cd ..\..
node agent\tests\run_lua_tests.mjs
node agent\tools\dev.mjs restart
node agent\tests\run_live.mjs --providers claude eval chat
```

`dev.mjs` uses its own user folder (`%USERPROFILE%\.aseprite-agent-dev\aseprite`) and agent home; it copies the extension (Windows needs admin rights for file links), so run `node agent\tools\dev.mjs install` after changing `agent\extension`.

## What to check, and report back

1. `npm test` and `run_lua_tests.mjs` pass.
2. In the stable Aseprite: open the AI Agent panel, send a message; the bridge starts by itself (`%USERPROFILE%\.aseprite-agent\daemon.log`) and the agent answers and edits a sprite.
3. Claude and Codex are both listed in the panel's provider box.
4. AI Agent menu > Check for Updates... says up to date (or offers the newest release) and, after an update, restarts Aseprite.
5. The dev instance and the stable one run at the same time without seeing each other's chats.

Known differences: the bridge starts with `start "" /B node ...`; Codex's login file is copied into the agent's Codex home instead of linked, so it is refreshed each time the agent process starts.
