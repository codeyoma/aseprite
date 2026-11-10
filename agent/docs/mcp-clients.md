# Connecting other MCP clients

The bridge is a plain MCP server over stdio, so any MCP client can use it without the Claude Code plugin. A client gets:

- **Tools**: everything in the README's tool table.
- **Prompts**: one per skill (built-in skills from `agent/skills`, plus your own from `~/.aseprite-agent/skills`, which replace a built-in of the same name). The prompt's name is the skill's name (`animate`, `check-sprite`, `pixel-fx`, ...), its description is the skill's description, and its optional `request` argument is added after the skill text as your request. The text starts with a short note telling the agent to read `read_guide("basics")` first and where cited rules live.
- **Resources**: `skill://<name>` for each skill (listed through the `skill://{name}` template) and `rules://<chapter>` for the pixel-art rules.

Aseprite must be running with the Aseprite Agent extension (see [INSTALL.md](INSTALL.md)).

## Which command to run

Use the same launcher as the Claude Code plugin, from your clone of this repository:

```
node /path/to/aseprite/agent/claude-plugin/bin/aseprite-mcp.mjs
```

It starts, in order: the bridge named by `ASEPRITE_AGENT_BRIDGE` (a path to `dist/index.js`); the bridge recorded in `~/.aseprite-agent/bridge.json` (every bridge that has run writes its own path there, so after one `npm run build` and one run from the clone it finds that one); or `npx -y aseprite-agent@<version>` from npm. You can also run the bridge directly with `node /path/to/aseprite/agent/bridge/dist/index.js`.

Desktop apps often start servers with a short `PATH`; if `node` is not found, use its absolute path (`which node`).

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/path/to/aseprite/agent/claude-plugin/bin/aseprite-mcp.mjs"]
    }
  }
}
```

## VS Code

`.vscode/mcp.json` in the workspace. The key is `servers`, and the transport is named:

```json
{
  "servers": {
    "aseprite": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/aseprite/agent/claude-plugin/bin/aseprite-mcp.mjs"]
    }
  }
}
```

## Claude Desktop

`claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`; Settings > Developer > Edit Config opens it):

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "/absolute/path/to/node",
      "args": ["/path/to/aseprite/agent/claude-plugin/bin/aseprite-mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop after editing it.

## Codex

`~/.codex/config.toml` (TOML, not JSON):

```toml
[mcp_servers.aseprite]
command = "node"
args = ["/path/to/aseprite/agent/claude-plugin/bin/aseprite-mcp.mjs"]
```

## Using the skills

Pick a skill from the client's prompt list (where it shows MCP prompts, for example a `/` menu) and give your request as the `request` argument, or attach a `skill://<name>` resource to a message. Clients without prompts or resources still have `list_skills` and `read_guide("<name>")`, which serve the same text.

Prompt names are read when the server starts; restart the server to see a skill you just added. A changed skill's text shows on the next request.

## What is not available this way

The bridge's HTTP endpoints (`/mcp`, `/mcp/ask`, `/mcp/scope/<id>`) serve the same prompts and resources, but they use a per-run token and exist for the agents the chat panel starts; connect other clients over stdio as above. The read-only `/mcp/ask` (Ask and Plan modes) has the skill and rule resources but no prompts, because a prompt asks the agent to carry out a workflow that edits the document.

The per-client config layouts follow aseprite-ai-artist's `examples/mcp-configs` (MIT, https://github.com/with-pebbly/aseprite-ai-artist).
