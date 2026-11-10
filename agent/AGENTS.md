# Working on the AI agent layer

- Domain terms and where each piece lives: `GLOSSARY.md`.
- Test commands (bridge, Lua, live): `docs/BUILD-macos.md` § Tests. Before pushing: `cd bridge && npm test` (CI runs the same) and `tests/run_lua_tests.sh` when `extension/` changed; live: `node tests/run_live.mjs <names>`.
- Generated files (plugin copies, `bridge/src/commands.json`): `cd bridge && npm run gen`; `npm test` fails when they are stale and warns when `extension/` changed since the last full passing `run_lua_tests.sh`. Optional pre-push hook that makes that warning fatal: `ln -s "$PWD/agent/tools/pre-push.sh" "$(git rev-parse --git-common-dir)/hooks/pre-push"` (from the repository root).
- Commit on `agent` (`git branch --show-current`); Developer mode works in its own worktree and only Apply moves this branch. After pushing, check that the `agent` workflow ran on your commit and passed: `gh run list -R codeyoma/aseprite --workflow agent.yml -L 1`.
- A new Lua module: `tools/link_extension.sh`, then restart Aseprite.
- File, shell and socket access in the extension go through `extension/agent.lua` (Aseprite asks permission per script file); `tools/check_extension.mjs` enforces it.
- Wire protocol changes: `extension/protocol.json` (params schema, version bump).
- Never distribute builds of this fork (Aseprite EULA); never `npm publish` without the user.
