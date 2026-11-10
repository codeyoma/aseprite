# Glossary

Domain terms for Aseprite Agent. Code, docs and architecture reviews use these names.

**Bridge**: the Node process (`agent/bridge`) between agents and Aseprite. It serves MCP to agents (stdio for agent sessions, localhost HTTP for agents the chat panel starts) and talks to the extension over WebSocket.

**Extension**: the Aseprite Lua extension (`agent/extension`). `agent.lua` wires its modules: **Document Handlers** (`document_handlers.lua`, what the bridge can ask of Aseprite, with no transport) and **Bridge Connection** (`bridge_connection.lua`, session file, WebSocket, handshake, reconnects). File, shell and socket access stay in `agent.lua`, because Aseprite asks permission per script file.

**Session file**: `~/.aseprite-agent/session.json`, where the newest bridge publishes its port, token and path so the extension can find it.

**Wire Protocol**: the JSON-RPC messages between bridge and extension, defined once in `agent/extension/protocol.json` (version, requests, binary results, bridge methods, chat events). Both sides check their code against it, and the bridge rejects a different version at hello.

**Agent Provider**: one agent the chat panel can run (Claude Code, Codex). Each provider names its ACP agent package and how to pass the system prompt, and keeps a stream-json adapter (the CLI command plus a parser of its JSON output) as a fallback (`agent/bridge/src/providers`).

**ACP Runtime**: how the chat runs agents by default: the Agent Client Protocol, through `claude-agent-acp` and `codex-acp`. One long-lived agent process per provider, one ACP session per Conversation; a message is `session/prompt`, Stop is `session/cancel`, and after a bridge restart the Conversation continues with `session/load` (`agent/bridge/src/acp.ts`, mapped to chat events by `acp_mapper.ts`). `ASEPRITE_AGENT_RUNTIME=stream` uses the stream-json CLIs instead.

**Plan**: the agent's checklist for the running turn (ACP `plan` updates), shown in the Chat Panel and updated in place.

**Permission request**: an ACP agent asking before it uses a tool that is not pre-approved. The Chat Panel shows the agent's options; no answer within two minutes rejects it.

**Conversation**: one chat thread with a provider, identified by the provider's own id (Claude session id, Codex thread id). The chat panel's Conversation module (`agent/extension/conversation.lua`) records its messages and steps and keeps the ids, so a conversation survives bridge restarts.

**Chat Panel**: the panel in Aseprite where the user types requests and sees the agent's steps.

**Tool**: an MCP tool the bridge offers agents (`get_state`, `execute_lua`, `snapshot`, ...). A tool is either an edit (changes the document) or a read.

**Tool table**: the single definition of every tool (`agent/bridge/src/tools.ts`): name, input, edit/read kind, step label and behaviour. MCP registration and chat labels come from it.

**State block**: the `<aseprite-state>` text sent with every chat message: sprite, palette, layers top to bottom with ids, tags, active layer/frame/cel and selections (`stateBlock()` in `document_handlers.lua`).

**Layer id**: `L` plus Aseprite's `Layer.id` (e.g. `L12`), stable for the session. Used in the state block, mentions and `layerById()`.

**Check**: the pixel-art check gate (`check` tool): mechanical rules (off-palette, orphan, semi-transparent, empty cels in a tag, frame-duration outliers, content outside the canvas) that return findings with coordinates and a fix. Agents run it before saying they are done; the chat shows its result as a badge on the turn.

**Mention**: a reference to a document object typed in the chat with `@` (picker) and shown as a `@[Body]` token; sent to the agent as `Body (aseprite://layer/L12)`.

**aseprite:// URI**: the address of a document object, shared by mentions and the agent's citations: `aseprite://layer/L12`, `frame/3`, `tag/<name>`, `cel/L12:3`, `palette/5`, `slice/<name>`, `selection`. Links in replies select the object when clicked (`Uri` in `document_handlers.lua`).

**Turn History**: where each agent reply sits in the sprite's undo history (`turn_history.lua`). It reverts and restores a whole reply and summarises what changed since the last reply (`<changes-since-your-last-reply>`, sent before the state block).

**Undo state id**: a never-reused id of an undo history state (this fork's `UndoState::id()`), read through `sprite.undoHistory.states` / `.current` and used with `sprite:undoTo(id)`.

**Step**: one row of an agent turn in the chat panel: a thought, a tool call with its result, or the reply.

**Script Panel**: a script dialog docked in the main window (`Dialog{ dockable = true }`), implemented by `ScriptPanel` in this fork.

**Step Capture**: before and after images of the active frame for each edit request (`execute_lua`, `run_command`, `undo`, `redo`), with a diff (changed pixels in red over a faded frame), kept in memory in a ring buffer of 50 (`agent/extension/step_capture.lua`). The Chat Panel attaches each capture to its edit step as thumbnails; the `diff_visual` tool compares the canvas with the last step or a named checkpoint.
