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

Aseprite only loads extensions from real folders: it skips a symlinked extension folder. Create a folder and symlink the files into it, so edits in `agent/extension` apply on the next Aseprite restart:

```bash
E="$HOME/Library/Application Support/Aseprite/extensions/aseprite-agent"
mkdir -p "$E"
ln -sf "$PWD/agent/extension/package.json" "$E/package.json"
ln -sf "$PWD/agent/extension/agent.lua" "$E/agent.lua"
ln -sf "$PWD/agent/extension/chat_panel.lua" "$E/chat_panel.lua"
```

On first use, Aseprite shows a Security dialog for `agent.lua` (reading `~/.aseprite-agent/session.json`). Tick "Give full trust to this script" and click "Give Script Full Access".

## Build the bridge

```bash
cd agent/bridge
npm install
npm run build
```

## Tests

Lua handlers, in batch mode (no GUI needed):

```bash
ASEPRITE_AGENT_TEST=1 build/bin/aseprite -b \
  --script-param ext="$PWD/agent/extension" \
  --script agent/tests/batch_test.lua
```

Guide recipes, in batch mode (runs every `-- recipe:` block in `agent/guide/recipes.md`):

```bash
ASEPRITE_AGENT_TEST=1 build/bin/aseprite -b \
  --script-param ext="$PWD/agent/extension" \
  --script-param guide="$PWD/agent/guide" \
  --script-param tmp="$(mktemp -d)" \
  --script agent/tests/recipes_test.lua
```

Regenerate the command catalog after updating from upstream:

```bash
python3 agent/tools/gen_commands.py
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
