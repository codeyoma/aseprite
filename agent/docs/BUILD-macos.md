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

Regenerate the generated files (plugin copies, and the command catalog after updating from upstream); `npm test` fails when one is stale:

```bash
cd agent/bridge && npm run gen
```

Live tests drive the real agents through the chat panel, with Aseprite open. `run_live.mjs` runs them with each provider, makes the scratch folders they need, and prints a summary (`--all` for every skill test, `--restart` to restart Aseprite first):

```bash
node agent/tests/run_live.mjs --restart shading normals export:unity
node agent/tests/run_live.mjs --providers codex --all
```

The summary has two categories. **tool**: the skill evals (`agent/tests/skills/*.eval.mjs`) run against the real Aseprite, with no model and no tokens. Each eval's fixture is built in Aseprite from its fake-document description. Its steps run through the bridge's MCP tools, and its check reads what Aseprite holds through `get_state` and `snapshot`. A failure is a tool or extension bug. Evals with no deterministic steps (for example `parallel-frames`) print `SKIP`:

```bash
node agent/tests/run_live.mjs --evals                    # every eval
node agent/tests/run_live.mjs eval:shade-sprite:dither   # some
node agent/tests/eval_live.mjs --keep dither             # directly; --keep leaves the eval's sprites open
```

**agent**: the chat tests. Hard checks (`PASS`/`FAIL`) prove the skill ran: the header names the skill, the result exists, and `check` reports 0 errors. Soft checks (`SOFT-PASS`/`SOFT-FAIL`) score what the model chose, such as layer and tag names, brightness thresholds and timing. They are listed in the summary but don't fail the run. `run_live.mjs` exits with 1 only when a hard check fails.

**Benchmarks** (`agent/tests/bench/<name>.json`) judge the art, not only the tools: each one builds a fixed sprite with its own palette, sends a fixed sequence of prompts through the panel, checks pass/fail criteria through the tools (frames, tags, layers, sizes, palette, `check` and `check_fx` errors), saves the result, and has the other provider score it blind on the 0-4 rubric in `agent/tests/bench/RUBRIC.md`. A run goes to `agent/tests/bench/runs/<date>-<provider>/<name>/` (`generation.yaml`, `filmstrip.png`, `final.png`, `final-1x.png`, `result.aseprite`). The exit code is 1 when a criterion failed:

```bash
node agent/tests/run_bench.mjs --list                              # the benchmarks
node agent/tests/run_bench.mjs                                     # all, drawn by Claude, judged by Codex
node agent/tests/run_bench.mjs --provider codex animate pixel-fx   # some, drawn by Codex, judged by Claude
node agent/tests/run_bench.mjs --no-judge recolor                  # criteria only
node agent/tests/run_bench.mjs --rejudge agent/tests/bench/runs/2026-11-11-claude   # score a run again
```

`--model <id>` records the drawing model (the panel does not report it) and `--judge-model <id>` picks the judge's. The benchmarks share one chat conversation, so start with a fresh panel (New chat) for a baseline.

End to end, with Aseprite open:

```bash
node agent/tests/mcp_smoke.mjs
node agent/tests/chat_live.mjs claude "Add a layer named Shadow"   # in-app chat, uses your Claude login
node agent/tests/chat_live.mjs codex "Rename it to Glow"           # same with Codex
node agent/tests/daemon_live.mjs                                   # panel starts a background bridge
node agent/demos/run_demos.mjs                                     # regenerates the README demos
```

Background clicks and typing do not reach Aseprite's custom UI, so the live tests drive the panel through `AsepriteAgent.chat()` instead.
