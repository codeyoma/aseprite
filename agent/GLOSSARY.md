# Glossary

Domain terms for Aseprite Agent. Code, docs and architecture reviews use these names.

**Bridge**: the Node process (`agent/bridge`) between agents and Aseprite. It serves MCP to agents (stdio for agent sessions, localhost HTTP for agents the chat panel starts) and talks to the extension over WebSocket.

**Extension**: the Aseprite Lua extension (`agent/extension`). `agent.lua` wires its modules: **Document Handlers** (`document_handlers.lua`, what the bridge can ask of Aseprite, with no transport) and **Bridge Connection** (`bridge_connection.lua`, session file, WebSocket, handshake, reconnects). File, shell and socket access stay in `agent.lua`, because Aseprite asks permission per script file. The Document Handlers use `pixels.lua` for hex colors, RGB images, pixel walking and base64, and `wire_params.lua` to check request params. Their **operation policy** comes from `protocol.json`: each request is a read, a write or a scoped write (and may need an active sprite); every write gets step capture, and a sub-agent's scope guard checks scoped writes and refuses the rest. Handler groups live in area files (`handlers_check.lua`, `handlers_color.lua`, `handlers_sprite.lua`). The **Document View** (`document_view.lua`) answers what the document looks like to the agent and the panel: layer ids and paths, the State block, the context line and `aseprite://` URIs. The Chat Panel's draft (text, mentions, attachments, the `/` picker and skill chip) is the **Composer** (`composer.lua`): a pure module that turns Enter into one outcome (run a command, pick, tip, confirm, send).

**Session file**: `~/.aseprite-agent/session.json`, where the newest bridge publishes its port, token and path so the extension can find it.

**Wire Protocol**: the JSON-RPC messages between bridge and extension, defined once in `agent/extension/protocol.json` (version, requests with their param schemas, binary results, bridge methods, chat events). Both sides check their code against it, and the bridge rejects a different version at hello. Params are checked on both sides: the bridge before sending, the extension (`wire_params.lua`) before a handler runs, which also resolves **layer references** (id or name) to layer ids and **frame specs** (`3`, `[1,3]`, `'2-4'`, `'all'`) to frame numbers in range, with one grammar shared by both sides.

**Agent Provider**: one agent the chat panel can run (Claude Code, Codex). Each provider names its ACP agent package and how to pass the system prompt, and keeps a stream-json adapter (the CLI command plus a parser of its JSON output) as a fallback (`agent/bridge/src/providers`).

**ACP Runtime**: how the chat runs agents by default: the Agent Client Protocol, through `claude-agent-acp` and `codex-acp`. One long-lived agent process per provider, one ACP session per Conversation; a message is `session/prompt`, Stop is `session/cancel`, and after a bridge restart the Conversation continues with `session/load` (`agent/bridge/src/acp.ts`, mapped to chat events by `acp_mapper.ts`). `ASEPRITE_AGENT_RUNTIME=stream` uses the stream-json CLIs instead.
**Runtime seam**: how ChatRunner runs a turn (`agent/bridge/src/runtime.ts`): `start(turn, sink)`, `stop()`, with two adapters, the ACP runtime and the stream runtime. ChatRunner owns conversation keys (`claude`, `claude:dev`, ...), builds the agent's message from the parts the panel sends (prompt, state, changes, attachments, mode) and emits the turn's end; the panel sends its whole map of conversation ids and never computes keys.

**Plan**: the agent's checklist for the running turn (ACP `plan` updates), shown in the Chat Panel and updated in place.

**Permission request**: an ACP agent asking before it uses a tool that is not pre-approved. The Chat Panel shows the agent's options; no answer within two minutes rejects it. In Agent mode Claude's shell runs in its "Manual" permission mode (set with `session/set_mode`), so commands that change things ask; tests drive the round trip with a scripted agent (`ASEPRITE_AGENT_ACP_AGENT`, `agent/bridge/test/helpers/fake_acp_agent.mjs`).

**Conversation**: one chat thread with a provider, identified by the provider's own id (Claude session id, Codex thread id). The chat panel's Conversation module (`agent/extension/conversation.lua`) records its messages and steps and keeps the ids, so a conversation survives bridge restarts.

**Chat Panel**: the panel in Aseprite where the user types requests and sees the agent's steps.

**Tool**: an MCP tool the bridge offers agents (`get_state`, `execute_lua`, `snapshot`, ...). A tool is either an edit (changes the document) or a read.

**Tool table**: the single definition of every tool (`agent/bridge/src/tools.ts`): name, input, edit/read kind, step label and behaviour. MCP registration and chat labels come from it. Every tool lives in a `*_tools.ts` module (core, command, timeline and guide tools as well as the skill tools), listed once in the **tool module registry** (`tool_modules.ts`); the `Tool` interface, result helpers and the **tool context** are in `tool.ts`. A tool runs with `run(input, ctx)`: the context is the Aseprite requester plus the Saved Commands store and, for the main agent, the sub-agent runner, built once per MCP server (no globals). Inputs several tools share (frame specs, an image source, a palette by name) are defined once in `tool_inputs.ts`.

**Document module**: how skill tools see and change the active sprite (`agent/bridge/src/document.ts`): `info()` (size, frames and durations, layers with ids, tags, palette, selection, from `get_state`), frame specs, layer pixels, putting images or new sprites, and the color and sprite writes (colors, palette, color maps, mirrored frames, layer splits, slices, swatches), over the existing wire requests. Every write refreshes `info()`. Tools never write Lua for this; tests use an in-memory fake document (`fake_document.mjs`) that does what the Lua handlers do.

**State block**: the `<aseprite-state>` text sent with every chat message: sprite, palette, layers top to bottom with ids, tags, active layer/frame/cel and selections (`stateBlock()` in `document_view.lua`).

**Layer id**: `L` plus Aseprite's `Layer.id` (e.g. `L12`), stable for the session. Used in the state block, mentions and `layerById()`.

**Check**: the pixel-art check gate (`check` tool): mechanical rules (off-palette, orphan, semi-transparent, empty cels in a tag, frame-duration outliers, content outside the canvas, identical neighboring frames, the ground line jumping between frames) that return findings with coordinates and a fix. Agents run it before saying they are done; the chat shows its result as a badge on the turn.

**Mention**: a reference to a document object typed in the chat with `@` (picker) and shown as a `@[Body]` token; sent to the agent as `Body (aseprite://layer/L12)`.

**aseprite:// URI**: the address of a document object, shared by mentions and the agent's citations: `aseprite://layer/L12`, `frame/3`, `tag/<name>`, `cel/L12:3`, `palette/5`, `slice/<name>`, `selection`. Links in replies select the object when clicked (`Uri` in `document_view.lua`).

**Turn controller**: the life of one reply in the Chat Panel (`turns.lua`): it starts the turn in the Conversation and Turn History, claims step captures for edit steps, finishes or fails it, and answers revert, restore and what changed since the last reply. Questions the panel asks the user (permissions, Developer apply and discard, revert anyway) go through the **Prompter** (`prompter.lua`): `app.alert` in the app, scripted answers in tests.

**Turn History**: where each agent reply sits in the sprite's undo history (`turn_history.lua`). It reverts and restores a whole reply and summarises what changed since the last reply (`<changes-since-your-last-reply>`, sent before the state block).

**Undo state id**: a never-reused id of an undo history state (this fork's `UndoState::id()`), read through `sprite.undoHistory.states` / `.current` and used with `sprite:undoTo(id)`.

**Step**: one row of an agent turn in the chat panel: a thought, a tool call with its result, or the reply.

**Script Panel**: a script dialog docked in the main window (`Dialog{ dockable = true }`), implemented by `ScriptPanel` in this fork.

**Step Capture**: before and after images of the active frame for every write request (the operation policy's writes), with a diff (changed pixels in red over a faded frame), kept in memory in a ring buffer of 50 (`agent/extension/step_capture.lua`); a reply step claims every capture since the last one. The Chat Panel attaches each capture to its edit step as thumbnails; the `diff_visual` tool compares the canvas with the last step or a named checkpoint.

**Attachment**: an image the user sends with a chat message so the agent can see it: the selection, the active layer or frame rendered to a PNG (upscaled to at most 512 px, `agent/extension/attachments.lua`), or an image file. The bridge sends attachments as ACP image blocks (`agent/bridge/src/attachments.ts`).

**Chat Mode**: how much the agent may do in a turn (#24). **Agent** uses every tool; **Ask** and **Plan** connect the agent to the bridge's read-only MCP endpoint (`/mcp/ask`, read tools only), and Plan asks for a numbered plan that **Apply plan** carries out in Agent mode. Switching between Agent and the read-only modes restarts the ACP agent and loads the same session with the other endpoint.

**AI layer**: a layer named `AI: <task>` that holds content the agent generated, created above the source layer with `aiLayer(task, prompt)`; the request is stored in `layer.properties("aseprite-agent").prompt`.

**Variations**: candidate results for one task, built by the agent as layers `AI: <task> v<i>` in a group `AI variations: <task>` (`variationLayer(task, i)`) and shown with the `propose_variations` tool. The user keeps one (it becomes the AI layer) or discards them; each is one undo step (`agent/extension/variations.lua`).

**Skill**: a markdown file of techniques for the agent. Built-in skills live in `agent/skills/<name>/SKILL.md` (with `title`, `category`, `needs`: `image` or `selection`, `tools`); guide topics in `agent/guide`; user skills in `~/.aseprite-agent/skills/<name>.md` or `<name>/SKILL.md` with optional frontmatter (`name`, `description`, `triggers`, and like built-ins `title`, `category`, `needs`) and replace a built-in topic of the same name. A chat message that contains a trigger word brings the skill along (inlined when short, otherwise a hint to `read_guide` it); `/skill:name` forces one (`agent/bridge/src/guide.ts`).

**Skill eval**: a check that a built-in skill's deterministic tools do what the skill promises (`agent/tests/skills/<name>.eval.mjs`): a fixture sprite on the fake document, the tool steps, and assertions. `npm test` runs one per skill and fails when a skill has none; skills whose tools all run inside Aseprite or call an agent are skipped with a reason, naming the Lua test that covers them when there is one. `run_live.mjs --evals` runs the same evals against the real Aseprite (`agent/tests/eval_live.mjs`: the fixture is rebuilt as Lua, the checks read `get_state`/`snapshot`), with no model.

**Contract suite**: request scenarios (fixture, wire requests, expected results, errors and pixels) in `agent/tests/contract/*.json`, replayed against both the fake document (`contract.test.mjs`) and the real Lua handlers (`contract_test.lua`), so the fake cannot drift from Aseprite. What the fake does not model it refuses with "fake document: … not supported".

**Live test**: a test that drives the real Aseprite and a real agent (`agent/tests/*_live.mjs`, run by `run_live.mjs`). The summary splits **tool** results (evals, deterministic) from **agent** results; hard checks prove the skill ran and its result is sound, **soft checks** (`soft()`) score the model's choices (names, thresholds, timing) and never fail the run.

**Lua-tests stamp**: a hash of the extension and `protocol.json`, written by a full passing `run_lua_tests.sh` (`agent/tests/.lua-tests-passed`); `npm test` warns when the extension changed since, and fails with `ASEPRITE_AGENT_REQUIRE_LUA=1` (the pre-push hook, `agent/tools/pre-push.sh`). Generated files are rebuilt by `npm run gen` and checked by `npm run gen:check`.

**Saved Command**: Lua the agent wrote and saved with `save_command`, kept in `~/.aseprite-agent/commands` (`commands.json` plus `<name>.lua`, a git repository with a commit per change). It runs as one undo step with an `args` table, from **My Commands** in the menu, from `/name args` in the chat (no agent turn), or through `run_saved_command` (`agent/bridge/src/saved_commands.ts`, `agent/extension/saved_commands.lua`).

**Timeline text**: the sprite's timeline as lines of text (`frames N`, `fps N`, `frame A-B duration Nms`, `tag NAME A-B direction [repeat=N]`, `layer NAME link|unlink A-B`). Frames, durations and tags are declarative (unlisted tags are removed); link lines are actions. `get_timeline_text` reads it and `apply_timeline_text` applies it in one undo step or returns a plan (`agent/extension/timeline_text.lua`).

**ase**: the command-line form of the tools (`agent/bridge/src/cli.ts`). Live mode starts a short-lived bridge that the extension connects to; file mode runs `aseprite -b` on a file.

**Plugin**: the Claude Code plugin in `agent/claude-plugin` (marketplace at the repository root): the `aseprite` MCP server, started by a launcher that finds the bridge through `~/.aseprite-agent/bridge.json`, and the guide topics as skills, generated by `npm run build`.

**Developer mode**: a Chat Mode in which the agent edits this fork with its normal coding tools in a **developer worktree** of its own (`~/.aseprite-agent/dev/worktrees/`, branch `dev/<date>-<slug>`, state in `~/.aseprite-agent/dev/state.json`), so the user's checkout never changes until they apply the work (`agent/bridge/src/developer.ts`). Rebuild & Relaunch first **applies**: it fast-forwards the user's branch to the agent's commits, refusing while the worktree has uncommitted changes, the checkout has changes to tracked files or is on another branch, or the branch moved (the agent rebases then). Then it runs `ninja aseprite` when non-extension files changed, sends build errors back to the agent, saves open sprites and the conversation, and restarts Aseprite. Discard stashes the agent's uncommitted changes, removes the worktree (the dev branch keeps its commits), and after an apply resets the user's branch to where it was, only while nothing changed since.

**Sub-agent**: an agent started by the lead agent's `spawn_agents` tool for one part of a multi-frame job, scoped to some frames (and optionally layers). Up to four run at once (`agent/bridge/src/subagents.ts`); each has its own MCP endpoint (`/mcp/scope/<id>`) that adds its scope to every request, and the extension's scope guard (`agent/extension/scope_guard.lua`) undoes any step that changes something outside it and highlights the scope's frames in the timeline. Its steps appear in the panel labeled with the scope.

**Skill Catalog**: guide topics, built-in skills and user skills in one list (user skills override by name), served to agents by `list_skills`/`read_guide` and to the panel by `skills.list`. Typing `/` in the chat shows matching skills and saved commands over the bottom of the log; Up/Down move the highlight and Enter or Tab picks it (keys reach Lua through the fork's `dlg:textedit{ onkeydown }`). A picked skill becomes a **skill chip** above the prompt and is sent as `/skill:name` in front of the next message (`agent/bridge/src/guide.ts`, `chat_panel.lua`).

**Known palettes**: the palettes `palette_from_image` compares against and `remap_to_palette` accepts by name: the ones Aseprite ships (`data/extensions/*` `.gpl` files) and the user's in `~/.aseprite-agent/palettes` (`.gpl`/`.hex`). None are bundled by the agent (`agent/bridge/src/palettes.ts`).

**Tone**: a source's pixel-weighted OKLab statistics (lightness, saturation, contrast, warmth) used to compare and match sprites; the color math lives in `agent/bridge/src/color.ts`, and the extension only reads colors (`collect_colors`) and applies color maps (`apply_color_map`).

**Pixel snap**: rebuilding upscaled or AI-generated "pixel art" at its native size (#37). The grid is the cell size and offset whose boundaries carry the most color change against chance (fractional cells allowed, small noisy changes ignored); each cell takes its dominant color (`agent/bridge/src/pixel_grid.ts`).

**Sheet import**: slicing a sprite sheet image into a new animated sprite (#41): by a grid (cell size from the gutters between sprites, margin keeping boundaries in gutters), by the sprites on it (8-connected shapes on a transparent or key-color background, nearby specks merged, reading order), or by an atlas JSON; frames are aligned bottom-center by default (`agent/bridge/src/sheet.ts`).

**Style summary**: how a sprite is built (#40): size, colors, shading ramps and their steps, outline (one dark color, selout, or none) and dithering, with rules for drawing new art in that style (`agent/bridge/src/style.ts`). Recreating from a reference works only from images the user attaches, and says that recreated game art is for study and personal use.

**Ramp**: a pixel-art color ramp through a base color, dark to light, with shadows turning cool and highlights warm (`make_ramp`, `agent/bridge/src/shading.ts`). **Auto-shading** gives each flat color a short ramp and picks a step per pixel from the shape's distance field lit from a direction; **selout** outlines use a darker shade of the color each outline pixel borders.

**RotSprite transform**: rotating or scaling pixel art without blending: upscale x8 with Scale2x, sample through the inverse transform, and when an axis shrinks take the most common color in each pixel's footprint so thin lines survive (`agent/bridge/src/animation.ts`). Used by `transform_layer` (in-betweens of rigid parts along eased arcs), `rotate_layer`, `squash_stretch` and `smear_frame`.

**Directions**: a character's facings as tags named by compass direction (`walk_S`, `E`, `idle-north`; S faces the viewer, E faces right). `direction_plan` lists what exists, what mirrors (E↔W, NE↔NW, SE↔SW) and what must be drawn; `mirror_direction` copies a tag flipped as the opposite direction (`agent/bridge/src/directions.ts`).

**Autotile set**: terrain tiles for every neighbor combination (47-tile blob, or 16 sides-only), composed from a 5-tile template (island, vertical, horizontal, fill, inner): each tile's four quarters are picked by its neighbors. Exported with neighbor masks as a Godot 4 TileSet (terrain peering bits), a Tiled wang set and JSON (`agent/bridge/src/tiles.ts`).

**Palette swap**: a recolored variant that maps whole ramps by position (dark to dark, light to light) so shading survives (`palette_swap`); for shaders, an index map (palette index per pixel) plus a lookup table with a row per variant (`export_palette_lut`, `agent/bridge/src/dither.ts`). **Ordered dithering** mixes two palette colors with a Bayer or checker pattern by how far a pixel sits between them.

**Normal map**: per-pixel surface directions for 2D lighting, made from a height field (a rounded bevel of the silhouette, the colors' lightness, or a grayscale height layer), quantized to a few tilt steps for a pixel look, in OpenGL (green up) or DirectX convention; kept on a hidden 'AI: normal <layer>' layer (`agent/bridge/src/normals.ts`).

**Emission and specular masks**: grayscale layers beside a normal map (hidden `AI: emission <layer>`, `AI: specular <layer>`): where the sprite glows regardless of light, and how shiny each pixel is, in a few gray steps (`agent/bridge/src/masks.ts`).

**Sub-pixel motion**: moving a drawing by a fraction of a pixel per frame by changing edge shades (sampled between pixels, snapped to the palette) instead of moving pixels, so slow moves in small sprites don't jump.

**Engine export**: frames packed into a grid sheet (trimmed with their offsets kept, padded and extruded against bleeding) plus metadata per engine: a Godot 4 SpriteFrames, a Unity .png.meta with slices and pivots, Phaser atlas and animations, a Tiled .tsx, and Aseprite's JSON hash; a normal layer gets a matching `_n` sheet (`agent/bridge/src/export.ts`).

**Pixel text and UI**: text drawn from Aseprite's bitmap fonts (`aseprite` 7 px, `mini` 5 px; CC BY 4.0), parsed like Aseprite's sprite-sheet fonts; UI panels and buttons with a border, highlight, shadow and rounded corners, a 9-patch slice for stretching, button states as tagged frames, colors snapped to the palette (`agent/bridge/src/ui.ts`).

**Voxel render**: a MagicaVoxel model (or layers stacked as height slices) drawn as 2:1 isometric pixel art, each voxel a 4x4 block with three shades of its material (lit top, mid left, dark right), back to front, in 90-degree turns (`agent/bridge/src/voxels.ts`).

**Model render**: a 3D model (glTF/GLB or OBJ) drawn by the bridge's own software renderer at the sprite's final size: orthographic, z-buffered, sampled at pixel centers with no anti-aliasing, lit in a few toon bands, with one scale and ground line shared by every direction and frame (`agent/bridge/src/model3d.ts`).
