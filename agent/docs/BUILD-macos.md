# Building this fork on macOS (Apple Silicon)

Tested on 2026-11-10 with macOS 27.2, Xcode 27.2, CMake 4.1.2, Ninja 1.13.2.

## Build Aseprite

```bash
git clone --recursive https://github.com/codeyoma/aseprite.git
cd aseprite
./build.sh --auto --norun
```

The `laf` submodule points to [codeyoma/laf](https://github.com/codeyoma/laf) (branch `agent-ime`), which adds input-method support on macOS. After pulling, run `git submodule update --init --recursive`.

`--auto` downloads the prebuilt Skia that matches `laf/misc/skia-tag.txt` into `~/deps`, configures a release build in `build/`, and compiles it with Ninja. The first build takes several minutes.

Run it:

```bash
open build/bin/Aseprite.app
```

Never distribute this build. The Aseprite EULA allows compiling the source only for personal use or to propose contributions.

## Install the agent extension for development

Aseprite only loads extensions from real folders: it skips a symlinked extension folder. `agent/tools/link_extension.sh` makes the folder and symlinks every file of `agent/extension` into it, so edits apply on the next Aseprite restart. Run it again after adding a Lua module (the live tests warn when one isn't linked):

```bash
agent/tools/link_extension.sh
```

On first use, Aseprite shows a Security dialog for `agent.lua` (reading `~/.aseprite-agent/session.json`). Tick "Give full trust to this script" and click "Give Script Full Access".

## Build the bridge

```bash
cd agent/bridge
npm install
npm run build
```

## Tests

Bridge unit tests, the skill evals and the extension checks (file access only in `agent.lua`, Lua syntax when `luac` is installed). No Aseprite needed; CI runs the same command:

```bash
cd agent/bridge && npm test
```

The extension's Lua tests in a headless Aseprite (every `agent/tests/*_test.lua`, plus a compile check of every module):

```bash
agent/tests/run_lua_tests.sh            # all
agent/tests/run_lua_tests.sh check pixels   # some, by name
```

Regenerate the command catalog after updating from upstream:

```bash
python3 agent/tools/gen_commands.py
```

Live tests drive the real agents through the chat panel, with Aseprite open. `run_live.mjs` runs them with each provider, makes the scratch folders they need, and prints a summary (`--all` for every skill test, `--restart` to restart Aseprite first):

```bash
node agent/tests/run_live.mjs --restart shading normals export:unity
node agent/tests/run_live.mjs --providers codex --all
```

End to end, with Aseprite open:

```bash
node agent/tests/mcp_smoke.mjs
node agent/tests/chat_live.mjs claude "Add a layer named Shadow"   # in-app chat, uses your Claude login
node agent/tests/chat_live.mjs codex "Rename it to Glow"           # same with Codex
node agent/tests/daemon_live.mjs                                   # panel starts a background bridge
node agent/demos/run_demos.mjs                                     # regenerates the README demos
```

Background clicks and typing do not reach Aseprite's custom UI, so the live tests drive the panel through `AsepriteAgent.chat()` instead.
