# Glossary

Domain terms for Aseprite Agent. Code, docs and architecture reviews use these names.

**Bridge**: the Node process (`agent/bridge`) between agents and Aseprite. It serves MCP to agents (stdio for agent sessions, localhost HTTP for agents the chat panel starts) and talks to the extension over WebSocket.

**Extension**: the Aseprite Lua extension (`agent/extension`). It connects to the newest bridge and executes requests inside Aseprite.

**Session file**: `~/.aseprite-agent/session.json`, where the newest bridge publishes its port, token and path so the extension can find it.

**Wire Protocol**: the JSON-RPC messages between bridge and extension, defined once in `agent/extension/protocol.json` (version, requests, binary results, bridge methods, chat events). Both sides check their code against it, and the bridge rejects a different version at hello.

**Agent Provider**: one agent CLI the chat panel can run (Claude Code, Codex). Each provider is an adapter that builds the CLI command for a message and parses the CLI's JSON output into provider events (`agent/bridge/src/providers`).

**Conversation**: one chat thread with a provider, identified by the provider's own id (Claude session id, Codex thread id). The chat panel's Conversation module (`agent/extension/conversation.lua`) records its messages and steps and keeps the ids, so a conversation survives bridge restarts.

**Chat Panel**: the panel in Aseprite where the user types requests and sees the agent's steps.

**Tool**: an MCP tool the bridge offers agents (`get_state`, `execute_lua`, `snapshot`, ...). A tool is either an edit (changes the document) or a read.

**Tool table**: the single definition of every tool (`agent/bridge/src/tools.ts`): name, input, edit/read kind, step label and behaviour. MCP registration and chat labels come from it.

**Step**: one row of an agent turn in the chat panel: a thought, a tool call with its result, or the reply.

**Script Panel**: a script dialog docked in the main window (`Dialog{ dockable = true }`), implemented by `ScriptPanel` in this fork.
