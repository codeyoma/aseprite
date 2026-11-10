# Working on the AI agent layer

- Domain terms and where each piece lives: `GLOSSARY.md`.
- Test commands (bridge, Lua, live): `docs/BUILD-macos.md` § Tests. Before pushing: `cd bridge && npm test` (CI runs the same) and `tests/run_lua_tests.sh` when `extension/` changed; live: `node tests/run_live.mjs <names>`.
- Commit on `agent` (`git branch --show-current`): a Developer-mode chat turn switches this checkout to a `dev/` branch. After pushing, check that the `agent` workflow ran on your commit and passed: `gh run list -R codeyoma/aseprite --workflow agent.yml -L 1`.
- A new Lua module: `tools/link_extension.sh`, then restart Aseprite.
- File, shell and socket access in the extension go through `extension/agent.lua` (Aseprite asks permission per script file); `tools/check_extension.mjs` enforces it.
- Wire protocol changes: `extension/protocol.json` (params schema, version bump).
- Never distribute builds of this fork (Aseprite EULA); never `npm publish` without the user.
