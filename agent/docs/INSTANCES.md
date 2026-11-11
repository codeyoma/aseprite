# Two instances: the user's stable Aseprite and the agent's dev one

The user works in one Aseprite while the agent develops and tests in another. They share nothing: settings,
extensions, recovery sessions, chats, attachments and the bridge are separate, so a test never takes over or
restarts the user's Aseprite. Code: `agent/tools/instances.mjs`, `dev.mjs`, `stable.mjs`, `release.mjs`.

| | stable (the user's) | dev (the agent's) |
|---|---|---|
| Program | `~/.aseprite-agent-stable/app/aseprite`, a copy built from the `stable` branch | `build/bin/aseprite` of the working checkout |
| Aseprite user folder | Aseprite's default (`~/Library/Application Support/Aseprite`, `%APPDATA%\Aseprite`) | `~/.aseprite-agent-dev/aseprite` (`ASEPRITE_USER_FOLDER`) |
| Agent home | `~/.aseprite-agent` | `~/.aseprite-agent-dev` (`ASEPRITE_AGENT_HOME`) |
| Extension | copied from the stable source | linked to `agent/extension` (edits apply on restart) |
| Started by | `/Applications/Aseprite AI.app` (macOS) or `node agent/tools/stable.mjs start` | `node agent/tools/dev.mjs start`; live tests and benchmarks |

`ASEPRITE_AGENT_HOME` is read by the bridge (`session.ts`) and the extension (`agent.lua`, `bridge_connection.lua`);
each instance's extension finds its own bridge through `<agent home>/bridge.json`.

## Releasing (the agent)

1. Unit tests (`npm test`), Lua tests and the related live tests pass on the dev instance.
2. `node agent/tools/release.mjs` moves `stable` on origin to HEAD and tags it `stable-<date>-<n>`; the tag message
   lists the commits.

## Updating (the user)

AI Agent menu > **Check for Updates...** (a note appears in the chat at startup when one is available). It shows the
release notes; **Update** fetches `stable` into `~/.aseprite-agent-stable/src`, rebuilds Aseprite there only when
something outside `agent/` changed (the app keeps running meanwhile), builds the bridge, then asks to restart. On
restart the installer waits for Aseprite to quit, copies the new program and extension in place, and starts it
again; open sprites are saved and reopened. From a terminal: `node agent/tools/stable.mjs update --wait --start`.

Builds never leave this machine (the Aseprite EULA forbids distributing them), so the machine needs the build tools:
Xcode, CMake and Ninja on macOS; Visual Studio 2022, CMake and Ninja on Windows (see `docs/BUILD-macos.md`).

## First setup

- Stable: `node agent/tools/stable.mjs update` (the first build takes a while), then on macOS
  `node agent/tools/stable.mjs launcher` makes `/Applications/Aseprite AI.app` (with the agent's logo as its icon).
- Dev: `node agent/tools/dev.mjs restart`. On the first start Aseprite asks whether `agent.lua` may read files and
  open sockets: tick "Give full trust to this script". The answer is kept in the dev user folder.
