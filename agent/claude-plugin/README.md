# Aseprite plugin for Claude Code

Gives Claude Code sessions in any folder the Aseprite tools (the `aseprite` MCP server) and the agent guide as skills:

- `aseprite`: rules for editing through the tools (read before the first edit)
- `aseprite-pixel-art`: style rules and a working loop for drawing and animating
- `aseprite-recipes`: tested Lua snippets for common tasks
- the built-in skills from `agent/skills` as `aseprite-<name>` (check and fix pixel art, retime an animation, variations, parallel frames, …)

Install from this repository's marketplace:

```
/plugin install aseprite --marketplace codeyoma/aseprite
```

Aseprite must be running with the Aseprite Agent extension (see `agent/docs/INSTALL.md`). The plugin starts the bridge from, in order: `ASEPRITE_AGENT_BRIDGE`, the bridge recorded in `~/.aseprite-agent/bridge.json` (any bridge you have run from a clone of this repository records itself), or `npx aseprite-agent` from npm.

The skills are generated from `agent/guide` by `npm run build` in `agent/bridge`; edit the guide, not the copies here.

## Codex

Add the bridge to `~/.codex/config.toml`:

```toml
[mcp_servers.aseprite]
command = "node"
args = ["/path/to/aseprite/agent/bridge/dist/index.js"]
```

and point Codex at the guide: `read_guide` serves the same topics from the bridge.
