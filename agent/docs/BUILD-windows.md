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
.\build.cmd --auto --norun
cd agent\bridge && npm ci && npm test && cd ..\..
node agent\tests\run_lua_tests.mjs
node agent\tools\dev.mjs restart
node agent\tests\run_live.mjs --providers claude eval chat
```

- `.\build.cmd`: cmd skips the current folder when `NoDefaultCurrentDirectoryInExePath` is set (some shells and agent sessions set it).
- `npm test` runs `agent\tools\gen_commands.py` through the `py` launcher or `python` (Windows' `python3` is often only the Microsoft Store stub).
- `dev.mjs` uses its own user folder (`%USERPROFILE%\.aseprite-agent-dev\aseprite`) and agent home; it copies the extension (Windows needs admin rights for file links), so run `node agent\tools\dev.mjs install` after changing `agent\extension`.
- Live tests in a fresh dev user folder ask for trust twice: for `agent.lua` on the first start, and for `agent_exec.lua` (the agent's Lua) the first time a test saves a file. Tick "Give full trust" in both, on the dev instance only.

## What to check, and report back

1. `npm test` and `run_lua_tests.mjs` pass.
2. In the stable Aseprite: open the AI Agent panel, send a message; the bridge starts by itself (`%USERPROFILE%\.aseprite-agent\daemon.log`) and the agent answers and edits a sprite.
3. Claude and Codex are both listed in the panel's provider box.
4. AI Agent menu > Check for Updates... says up to date (or offers the newest release) and, after an update, restarts Aseprite.
5. The dev instance and the stable one run at the same time without seeing each other's chats.

Sharp chat text: Edit > Preferences > General, Screen Scaling 100% and UI Elements Scaling 200% (the same size on
screen). With Screen Scaling 200%, upstream's default on a large screen, Aseprite draws at half resolution and the
chat panel's text looks blocky. A new user folder starts that way on this fork; an older one keeps its setting.

Known differences:
- The panel starts the bridge with `start "" /B node ... --daemon`; the daemon starts itself again without a console, so cmd's window only flashes. Every console program the bridge starts is hidden (`platform.ts`), or each would open a window.
- Codex's login file is linked into the agent's Codex home: a symlink with Developer Mode or admin rights, else a hard link (same drive), else a copy (then a login refresh stays in the agent's copy).
- Aseprite sets the `en-US` locale, which only Windows accepts: Lua's `%w`, `%a` and string `<` follow it there. Build names with ASCII ranges (`[A-Za-z0-9]`) and sort by numbers or ranks.

## Checked on Windows (2026-11-12, #108)

Windows 11 Pro 10.0.26300, Visual Studio Community 2022 17.14 (MSVC 14.44), CMake and Ninja from Visual Studio, Node 24.19, Claude Code 2.1.296, Codex CLI 0.162.1. The dev instance: the build (with `Image:histogram()` and `Image:isolatedPixels()`), `npm test`, `run_lua_tests.mjs`, `native_bench.mjs`, and the live tests `chat` (Claude and Codex), `daemon`, `juice`, `smear`, `fluid`, `pipeline`, `memory` (a folder with a space on `D:\`, a Korean sprite name), `image_gen` and the evals (all but `character-motions`, whose fixture needs the chat panel on every platform), and a Korean chat in the panel. The stable instance: `stable.mjs update` (stable-2026-11-11-14), `launcher` and `start` work, and the first start asks for trust; checks 2 to 5 wait for a release that has the Windows fixes.
