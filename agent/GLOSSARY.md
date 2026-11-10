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

**Attachment**: an image the user sends with a chat message so the agent can see it: the selection, the active layer or frame rendered to a PNG (upscaled to at most 512 px, `agent/extension/attachments.lua`), or an image file. The bridge sends attachments as ACP image blocks (`agent/bridge/src/attachments.ts`).

**Chat Mode**: how much the agent may do in a turn (#24). **Agent** uses every tool; **Ask** and **Plan** connect the agent to the bridge's read-only MCP endpoint (`/mcp/ask`, read tools only), and Plan asks for a numbered plan that **Apply plan** carries out in Agent mode. Switching between Agent and the read-only modes restarts the ACP agent and loads the same session with the other endpoint.

**AI layer**: a layer named `AI: <task>` that holds content the agent generated, created above the source layer with `aiLayer(task, prompt)`; the request is stored in `layer.properties("aseprite-agent").prompt`.

**Variations**: candidate results for one task, built by the agent as layers `AI: <task> v<i>` in a group `AI variations: <task>` (`variationLayer(task, i)`) and shown with the `propose_variations` tool. The user keeps one (it becomes the AI layer) or discards them; each is one undo step (`agent/extension/variations.lua`).

**Skill**: a markdown file of techniques for the agent. Built-in skills live in `agent/skills/<name>/SKILL.md` (with `title`, `category`, `needs`, `tools`); guide topics in `agent/guide`; user skills in `~/.aseprite-agent/skills/<name>.md` with optional frontmatter (`name`, `description`, `triggers`) and replace a built-in topic of the same name. A chat message that contains a trigger word brings the skill along (inlined when short, otherwise a hint to `read_guide` it); `/skill:name` forces one (`agent/bridge/src/guide.ts`).

**Saved Command**: Lua the agent wrote and saved with `save_command`, kept in `~/.aseprite-agent/commands` (`commands.json` plus `<name>.lua`, a git repository with a commit per change). It runs as one undo step with an `args` table, from **My Commands** in the menu, from `/name args` in the chat (no agent turn), or through `run_saved_command` (`agent/bridge/src/saved_commands.ts`, `agent/extension/saved_commands.lua`).

**Timeline text**: the sprite's timeline as lines of text (`frames N`, `fps N`, `frame A-B duration Nms`, `tag NAME A-B direction [repeat=N]`, `layer NAME link|unlink A-B`). Frames, durations and tags are declarative (unlisted tags are removed); link lines are actions. `get_timeline_text` reads it and `apply_timeline_text` applies it in one undo step or returns a plan (`agent/extension/timeline_text.lua`).

**ase**: the command-line form of the tools (`agent/bridge/src/cli.ts`). Live mode starts a short-lived bridge that the extension connects to; file mode runs `aseprite -b` on a file.

**Plugin**: the Claude Code plugin in `agent/claude-plugin` (marketplace at the repository root): the `aseprite` MCP server, started by a launcher that finds the bridge through `~/.aseprite-agent/bridge.json`, and the guide topics as skills, generated by `npm run build`.

**Developer mode**: a Chat Mode in which the agent edits this fork (the repository the bridge runs from) with its normal coding tools, on a `dev/<date>-<slug>` branch that remembers its base (`agent/bridge/src/developer.ts`). Rebuild & Relaunch runs `ninja aseprite` when non-extension files changed, sends build errors back to the agent, saves open sprites and the conversation, and restarts Aseprite; Discard stashes uncommitted changes and returns to the base branch.

**Sub-agent**: an agent started by the lead agent's `spawn_agents` tool for one part of a multi-frame job, scoped to some frames (and optionally layers). Up to four run at once (`agent/bridge/src/subagents.ts`); each has its own MCP endpoint (`/mcp/scope/<id>`) that adds its scope to every request, and the extension's scope guard (`agent/extension/scope_guard.lua`) undoes any step that changes something outside it and highlights the scope's frames in the timeline. Its steps appear in the panel labeled with the scope.

**Skill Catalog**: guide topics, built-in skills and user skills in one list (user skills override by name), served to agents by `list_skills`/`read_guide` and to the panel by `skills.list`. Typing `/` in the chat shows matching skills and saved commands over the bottom of the log; picking a skill fills `/skill:name ` (`agent/bridge/src/guide.ts`, `chat_panel.lua`).
