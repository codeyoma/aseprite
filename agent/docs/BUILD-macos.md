# Building this fork on macOS (Apple Silicon)

Tested on 2026-11-10 with macOS 27.2, Xcode 27.2, CMake 4.1.2, Ninja 1.13.2.

## Build Aseprite

```bash
git clone --recursive https://github.com/codeyoma/aseprite.git
cd aseprite
./build.sh --auto --norun
```

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

End to end, with Aseprite open:

```bash
node agent/tests/mcp_smoke.mjs
```
