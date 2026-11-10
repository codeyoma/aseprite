# Glossary

Domain terms for Aseprite Agent. Code, docs and architecture reviews use these names.

**Bridge**: the Node process (`agent/bridge`) between agents and Aseprite. It serves MCP to agents (stdio for agent sessions, localhost HTTP for agents the chat panel starts) and talks to the extension over WebSocket.

**Extension**: the Aseprite Lua extension (`agent/extension`). `agent.lua` wires its modules: **Document Handlers** (`document_handlers.lua`, what the bridge can ask of Aseprite, with no transport) and **Bridge Connection** (`bridge_connection.lua`, session file, WebSocket, handshake, reconnects). File, shell and socket access stay in `agent.lua`, because Aseprite asks permission per script file.

**Session file**: `~/.aseprite-agent/session.json`, where the newest bridge publishes its port, token and path so the extension can find it.

**Wire Protocol**: the JSON-RPC messages between bridge and extension, defined once in `agent/extension/protocol.json` (version, requests, binary results, bridge methods, chat events). Both sides check their code against it, and the bridge rejects a different version at hello.

**Agent Provider**: one agent CLI the chat panel can run (Claude Code, Codex). Each provider is an adapter that builds the CLI command for a message and parses the CLI's JSON output into provider events (`agent/bridge/src/providers`).

**Conversation**: one chat thread with a provider, identified by the provider's own id (Claude session id, Codex thread id). The chat panel's Conversation module (`agent/extension/conversation.lua`) records its messages and steps and keeps the ids, so a conversation survives bridge restarts.

**Chat Panel**: the panel in Aseprite where the user types requests and sees the agent's steps.

**Tool**: an MCP tool the bridge offers agents (`get_state`, `execute_lua`, `snapshot`, ...). A tool is either an edit (changes the document) or a read.

**Tool table**: the single definition of every tool (`agent/bridge/src/tools.ts`): name, input, edit/read kind, step label and behaviour. MCP registration and chat labels come from it.

**State block**: the `<aseprite-state>` text sent with every chat message: sprite, palette, layers top to bottom with ids, tags, active layer/frame/cel and selections (`stateBlock()` in `document_handlers.lua`).

**Layer id**: `L` plus Aseprite's `Layer.id` (e.g. `L12`), stable for the session. Used in the state block, mentions and `layerById()`.

**Check**: the pixel-art check gate (`check` tool): mechanical rules (off-palette, orphan, semi-transparent, empty cels in a tag, frame-duration outliers, content outside the canvas) that return findings with coordinates and a fix. Agents run it before saying they are done; the chat shows its result as a badge on the turn.

**Mention**: a reference to a document object typed in the chat with `@` (picker) and shown as a `@[Body]` token; sent to the agent as `Body (aseprite://layer/L12)`.

**aseprite:// URI**: the address of a document object, shared by mentions and the agent's citations: `aseprite://layer/L12`, `frame/3`, `tag/<name>`, `cel/L12:3`, `palette/5`, `slice/<name>`, `selection`. Links in replies select the object when clicked (`Uri` in `document_handlers.lua`).

**Step**: one row of an agent turn in the chat panel: a thought, a tool call with its result, or the reply.

**Script Panel**: a script dialog docked in the main window (`Dialog{ dockable = true }`), implemented by `ScriptPanel` in this fork.
