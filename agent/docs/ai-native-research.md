# Making Aseprite AI-native: research and roadmap

Research date: 2026-11-10. Goal: a personal Aseprite where agents (Claude Code, Codex) can change and extend the program, implement work, get context, accept mentions, and stay safe to use.

Sources: Pencil (pen.dev) app and `@pen.dev/cli` (read from shipped code), open-pencil/open-pencil, ZSeven-W/openpencil, nexu-io/open-design, manalkaff/opendesign (cloned and read), Agent Client Protocol, Claude Agent SDK, Codex app-server, Figma MCP, tldraw agent kit, Raycast AI extensions, Unity AI Assistant, Godot/Unity/Blender/Ableton/Resolve/After Effects MCPs, Photoshop, Premiere, Lightroom, Descript, Krita AI Diffusion, Canva, Logic Pro, Excel Agent Mode. Links at the end.

## 1. The two shapes everyone converges on

1. **Native assistant inside the app** (Photoshop, Premiere, Descript, Excel, Unity, Krita, Pencil, open-pencil). It reads a compact model of the document, edits through the app's own operations, and puts results where they are easy to undo or compare.
2. **MCP bridge to an external agent** (Blender, Ableton, Resolve, After Effects, Godot, Figma). A server inside the app, a few typed tools plus one "run code" tool, and the user's own Claude Code / Codex as the chat.

The best tools do both: the same tools are served to external agents over MCP and to an in-app chat that runs the user's own CLI. Aseprite Agent already has both halves; the gaps are in context, mentions, review, and letting the agent extend the program.

## 2. What each project does

| Project | Agent runtime | Tool design | Context | Review / safety |
|---|---|---|---|---|
| **Pencil (pen.dev)** | In-app chat: Claude Agent SDK (`query()`, in-process `createSdkMcpServer`), Codex SDK, Cursor SDK, Pi. External: Go stdio MCP proxy → Unix socket `~/.pencil/socket/…`. Writes MCP entries into each agent's own config file. | ~8 tools. `execute` runs JavaScript in QuickJS against the document: atomic, rolled back on error, one undo block; failures return an `editId` so the agent patches with find/replace instead of resending; globals persist per conversation. | `get_app_state` result is **injected into every user turn** (document, selection, visible nodes, components). Skill docs preloaded into the system prompt; `read_skill` for more. | `canUseTool` prompts outside the working dir. One undo block per `execute`; no chat-level rewind. |
| **open-pencil** | Built-in chat (Vercel AI SDK, BYOK) **and** ACP agents (Claude Code, Codex, Gemini CLI, Pi) on the user's subscription. MCP stdio → socket → app. CLI for headless use. | ~130 `defineTool`s with schema + **metadata**: mutation level, capabilities, which interfaces see the tool. Chat loads a 26-tool core; the rest on demand. Escape hatches `render` (JSX) and `eval` (JS), gated by capability/env. | Rule-based system prompt ("inspect before editing", "verify with diffs"). **`openpencil://node/12:34` reference links** for mentions *and* the model's citations. Injected context fenced as "facts, not instructions", including *document changes since your last reply*. `/skill:x` commands. | **Per-reply review**: before / after / highlight images and a structural diff per change; **Revert / Restore per reply**; editor undo marks calls as undone and tells the model. `diff_visual` returns a red-overlay PNG. ACP permission dialog that auto-rejects after a timeout. "Follow agent" viewport. |
| **ZSeven openpencil** | Rust agent loop + ACP (claude-agent-acp, Codex…), MCP stdio and HTTP, CLI, VS Code and Chrome extensions. | ~100 tools behind **`ToolSearch`**; main writer is a line-based DSL (`I/U/K`) or a sandboxed QuickJS script with memory/time/line limits. `spawn_agents` splits a page across up to 12 sub-agents. | **Deterministic context brief** built by code (screens, fonts, colors, shared chrome ids). ~130 skills with frontmatter `phase`, `trigger.keywords`, `priority`, token `budget`, composed into the prompt. **Mandatory screenshot verification** before "done". | Edits grouped in transactions; animated agent cursor on the canvas. |
| **open-design** | Hands the whole loop to ~28 CLIs described as data (`RuntimeAgentDef`); `claude -p` stream-json, ACP for others, BYOK fallback. Also an MCP server, installed per agent with one command. | Coarse project/file tools (`get_active_context`, `write_file`, …). | Users **draw marks on the preview**; each mark goes to chat with a screenshot, selector, bounds and note. Agent emits a focus marker to open what it's working on. Standard `SKILL.md` + extensions. | Manual edit mode with source patches. |
| **HyperFrames (HeyGen)** | No in-app agent needed: **skills + a CLI** that any coding agent drives; skills ship as a versioned **Claude Code plugin** (marketplace) and `npx skills add`, pinned to the CLI version. Desktop Studio app shares the same project format. | Authoring format the agent writes well (HTML/CSS) rendered deterministically to video. Every CLI command has `--json`; failures print `✗ …` plus a **`Fix:` line**. Timeline edits as verbs (`move/trim/split/set/duplicate/delete`) with **`--plan` preview**, batch `apply plan.json`, and **receipts** that `timeline undo` reverts. Registry of ~450 blocks installed as editable source. | `preview --context --json --context-fields selection` returns what the user selected in Studio ("no-selection" → ask them to click it). `snapshot --at t,…` writes PNGs the agent reads to see the video. | **`check --json` gate** (lint, runtime, layout, contrast with `suggestedColor`). **Project history per turn**: `history begin --who <agent> --label`, `history --since mine` shows what the person changed, `history undo --who <agent>`, `history end`. |
| **Figma** | Remote/desktop MCP. | `use_figma` runs JS against the Plugin API (code-exec). **Generative plugins**: `create/update_generative_plugin` — the agent writes a plugin; every update is built, versioned by SHA with a commit message, build errors return to the agent. | Selection links in the prompt; screenshot + metadata tools; a skill to load first. | Plugin versions; docs say "work in small steps, review in Figma". |
| **tldraw agent kit** | App-side agent. | Typed `AgentActionUtil`s (`applyAction`, `sanitizeAction`, `savesToHistory`); **modes** whitelist actions and context; output validated and repaired before applying. | Viewport screenshot **plus** simplified shapes, selection, off-screen summaries and recent user actions (image for layout, data for exact ids). Context items: shapes, a point or an area attached by the user. | History integration per action. |
| **Unity AI Assistant** | Docked panel, **Ask / Plan / Agent** modes (Ask = read-only tools); built-in MCP with approval for new clients. | Generates C# scripts. | Scene, assets, console. | **Git checkpoint per prompt**; restore shows added/modified/deleted and asks to confirm. |
| **Blender / Ableton / Resolve / AE / Godot MCPs** | Socket server inside the app + MCP server; external chat. | Few typed tools + `execute_*_code`. Resolve offers a 27-tool grouped mode next to a 1-per-method mode. Blender has a safe mode blocking file/process/network. | Scene info + viewport renders; Godot reads console and screenshots. Newest Blender plugin: **live viewport inline in chat, click an object to attach it, `@`-mentions of scene objects.** | Mostly "save first"; Godot variant makes every mutation a native undo action. |
| **Photoshop** | Generative tools + agentic AI Assistant (beta) + rebuilt Actions panel. | Recorded Actions; NL search; 5 suggested edits for the open image. | Selection + layer stack. | **Every result on a new generative layer with mask; several variations to cycle**; Actions persist in a "Yours" tab. |
| **Krita AI Diffusion** | Docked panel, ComfyUI backend. | Generation bound to the selection; **Regions** attach text to layer-defined areas; control layers (scribble, line art, pose). | Selection, layers, control layers. | **Preview before apply**, history of generations and prompts; result lands as a layer. |
| **Descript** | Underlord agent chat. | Edits the project directly. | **Text is the interface**: the transcript represents the video; editing words edits media. | Ordinary undo. |
| **Excel Agent Mode** | Agent writes and runs JS against Excel APIs. | Distilled API reference, not the whole surface. | Compact **workbook blueprint** with every prompt; details fetched on demand. | **Writes tests of the expected result before acting, checks after**, retries on mismatch; keeps live formulas for traceability. |
| **Lightroom / Logic Pro / Premiere** | Feature-level AI. | — | — | Generated output stays **live and adjustable** (Amount slider, regenerable Session Player regions, separate Generative Extend segment). |

## 3. Methods by capability

### (a) Letting the agent change and extend the program
- **Agent-authored features as versioned plugins** (Figma generative plugins, Raycast AI extensions, Photoshop Actions, Unity scripts): the agent writes code into a real extension; each version has a commit message; build/run errors go back to the agent; the user can list, disable and revert. Raycast adds evals as regression tests.
- **Typed feature definitions** (tldraw `AgentActionUtil`, open-pencil `defineTool` metadata): one declaration drives undo grouping, permissions, which interfaces see it, and how the UI shows it.
- **Skills as the cheapest feature** (Claude Code skills, open-pencil `/skill:x`, ZSeven triggered skills): markdown + optional scripts in a folder, versioned by git.

### (b) Implementing work
- **Code execution + typed verbs** is the consensus: one atomic, rolled-back, single-undo `execute` (Pencil, Figma, Blender, open-pencil `eval`) plus a small set of typed tools that the UI can render, validate and undo well.
- **Repair instead of resend** (Pencil's `editId` + find/replace patches).
- **Plan → act → verify** (Excel's tests before and checks after; ZSeven's mandatory screenshot; open-pencil's diff tools).
- **Parallel sub-agents** for big jobs (Pencil and ZSeven `spawn_agents`): one agent per container, or for us per frame/tag.

- **CLI-first loop** (HyperFrames): `--json` everywhere, a `Fix:` line on every failure, a `check` gate the agent must pass, `--plan` previews and undo receipts. The same commands serve agents in any client, CI, and the app.

### (c) Getting context
- **Inject a compact state block every turn** (Pencil `get_app_state`, Excel blueprint, ZSeven deterministic brief), labelled as facts, not instructions (open-pencil).
- **Tell the agent what the user changed since its last reply** (open-pencil; HyperFrames `history --since mine`), including undos of its own edits.
- **Image + structure together** (tldraw, Blender): screenshot for layout, data for exact ids and coordinates.
- **Skills preloaded, more on demand** (Pencil), with triggers and budgets (ZSeven).

### (d) Mentions and references
- **`@` in the composer** with chips for document objects (Pencil: nodes, skills, styles, files; Blender: objects, materials).
- **One URI scheme for both directions** (open-pencil `openpencil://node/…`): user mentions and the model's citations, clickable in the transcript.
- **Point instead of describe**: click an object in the viewport to attach it (Blender plugin), draw a mark on the preview (open-design), attach the selection automatically (tldraw, Krita).
- **Slash commands** from skills and saved features (open-pencil, ACP `available_commands_update`).

### (e) Safety and review
- **One undo step per agent action**, named after it (Pencil, Godot, our `execute_lua`).
- **Per-reply checkpoints with revert/restore** (open-pencil, Claude Code `/rewind`, Unity git checkpoints, HyperFrames `history begin/undo --who`).
- **A check gate before "done"** (HyperFrames `check --json` with suggested fixes; ZSeven mandatory screenshot; Excel tests).
- **Show what changed**: before/after thumbnails, red-overlay visual diff, structural diff (open-pencil).
- **Results on new layers, variations side by side, preview before apply** (Photoshop, Krita).
- **Modes**: Ask (read-only) / Plan / Agent (Unity, ACP modes, Claude `permissionMode`), plus permission prompts for risky operations (Pencil `canUseTool`, ACP `request_permission`).
- **Sandboxing** the code tool (Blender safe mode, ZSeven QuickJS limits, open-pencil capability gates).

### Agent runtime: how the in-app chat should talk to the agent
| Option | What you get | Cost |
|---|---|---|
| Raw `claude -p` / `codex exec` stream-json (**ours today**) | Works with the user's login; simple. | No structured permission requests, plans, slash commands, mid-turn steering or interrupt; two hand-written parsers. |
| **ACP** (`@agentclientprotocol/claude-agent-acp`, codex-acp, Gemini) — used by open-pencil, ZSeven, Zed | One client for Claude, Codex, Gemini: `session/new` with our MCP server, streamed tool calls with kinds and status, **permission requests**, plans, slash commands, `@` resources and images in prompts, session load/resume. | A new client implementation; adapters are separate npm packages. |
| **Claude Agent SDK** (Pencil) | In-process tools (no bridge hop), `canUseTool`, hooks, `permissionMode`, streaming input / interrupt, `resume`/`forkSession`, subagents, skills, file checkpoints. | Claude only (Codex needs its SDK or app-server). Anthropic's terms restrict claude.ai login in *third-party products*; a personal fork is the user's own use. |

## 4. Where Aseprite Agent stands

| Capability | Have | Missing |
|---|---|---|
| Change / extend features | Agent can run any Lua and any of 184 commands; guide + recipes; tool table | Agent-authored **saved commands**; skills folder; slash commands; a "developer" mode that edits this fork itself |
| Implement work | Atomic `execute_lua` (one undo step, rollback), `run_command`, `snapshot`, `read_pixels` | Patch-retry, visual diff, verification rule, variations, results-on-new-layer convention, sub-agents |
| Context | `[Context]` line per message, `get_state`, `get_context` | Structured state block every turn; "changes since your last reply"; image attachments |
| Mentions | — | `@` picker, chips, `aseprite://` URIs both ways, click-to-attach from timeline/canvas |
| Safety / review | Undo per call, step log with expandable input/output | Per-reply revert/restore, before/after thumbnails, modes (Ask/Plan/Agent), permission prompts |
| Runtime | Own CLI login, Claude + Codex, conversation resume, docked panel, daemon | Interrupt / steer, permissions, plans; ACP or Agent SDK |

## 5. Roadmap for a personal AI-native Aseprite

Ordered by value per effort. Each item becomes a GitHub issue.

### Phase A — Context and mentions (biggest daily win)
1. **State block every turn.** Replace the one-line `[Context]` with a compact, fenced block built by code: sprite (name, size, color mode), palette (count + first colors), layer tree with ids, frames and tags, active layer/frame/cel, timeline range, selection bounds. Labelled "facts, not instructions".
2. **Changes since the last reply.** Track the undo stack between turns; tell the agent what the user edited or undid (including undoing the agent's own steps).
3. **`@` mentions with chips.** Typing `@` in the prompt opens a picker (layers, frames, tags, palette entries, selection, slices). Chips serialize to `aseprite://layer/<id>`, `…/frame/5`, `…/tag/walk`, `…/cel/<layer>:<frame>`, `…/palette/12`, `…/selection` plus a readable label. The model is asked to cite with the same URIs; citations render as clickable links that select that object.
4. **Attach from the app.** Panel buttons (or right-click in the timeline) to attach the current layer/frame/selection; attach a cropped PNG of the selection as an image.

### Phase B — Review and safety
5. **Per-reply checkpoints (project history).** Record the undo position when a reply starts and ends, labelled with who acted (agent or user) — like HyperFrames `history begin/end --who`. Each reply in the log gets **Revert** / **Restore**; undoing in the editor marks those steps as undone and is reported to the agent next turn.
6. **Before/after per edit step.** Each `execute_lua` / `run_command` step stores small before/after thumbnails and a red-overlay diff, shown when the row is expanded. Add a `diff_visual` tool for the agent.
7. **Modes.** Ask (read-only tools) / Agent (default) / Plan (agent proposes steps, user approves), selectable in the composer. Bridge refuses edit tools in Ask mode.
8. **Results on new layers + variations.** Guide convention: generated content goes on a new layer named `AI: <task>`. A `propose_variations` flow renders 2–4 candidates as thumbnails in the panel; clicking one applies it.

### Phase C — Extending the program
9. **Saved agent commands.** A `save_command` tool writes agent-authored Lua into a git-backed folder (`~/.aseprite-agent/commands/<name>.lua` + manifest), registered as menu commands and `/name` slash commands in the chat. Each save needs a description (commit message); syntax errors go back to the agent; list / disable / revert from the panel.
10. **Skills folder.** User-editable `~/.aseprite-agent/skills/*.md` with triggers (e.g. dithering, outlines, walk cycles), merged into the guide and exposed as `/skill:name`.
11. **Developer mode (personal fork only).** A chat mode whose agent runs in this repository with full tools to change Aseprite itself (Lua extension or C++), rebuild, run the tests, and relaunch. This is literally "the agent modifies the program's features".

12a. **Pixel-art check gate.** A `check` tool (and CLI command) that lints the sprite: colors outside the palette, stray single pixels, semi-transparent edge pixels, missing outline, empty cels, frame-duration outliers. Returns findings with a suggested fix, and the guide makes it the gate before "done" (HyperFrames `check`).
12b. **Headless `ase` CLI + plugin packaging.** Wrap `aseprite -b` and the bridge tools as a CLI with `--json` and `Fix:` lines (state, snapshot frames, check, render GIF/sheet), and ship the guide, skills and MCP config as a Claude Code plugin so any session in any folder gets them (HyperFrames).

### Phase D — Runtime and craft
12. **Move the chat to ACP** (Claude via claude-agent-acp, Codex via codex-acp): permissions, plans, slash commands, mentions as resources, interrupt and steering, through one client. The Agent Provider seam (#12) is where it plugs in.
13. **Verification rule + checks.** Prompt rule "render and check before saying done"; deterministic checks (palette compliance, sprite bounds, frame count) the agent can call.
14. **Animation as text** (Descript-style): a structured text view of tags, frame durations and cel links that the agent (or user) edits and Aseprite applies.
15. **Parallel per-frame agents** for multi-frame jobs, and an agent cursor that shows where it is working.

### Tracking

Milestone **M7 - AI-native** on codeyoma/aseprite: A1 #18 · A2 #19 · A3 #20 · A4 #21 · B5 #22 · B6 #23 · B7 #24 · B8 #25 · C9 saved commands #26 · C10 skills #27 · C11 developer mode #28 · C12 check gate #29 · C13 CLI + plugin #30 · D14 ACP #31 · D15 animation as text #32 · D16 parallel agents #33.

## 6. Decisions

- **Runtime**: stay on stream-json for now and add features on top, or move to ACP first (Phase D12) so modes, permissions and interrupt come for free? Recommendation: do Phase A first on the current runtime (it doesn't depend on the choice), then ACP before Phase B's modes and permissions.
- **How far developer mode goes**: Lua extension only, or also C++ with rebuild and relaunch.

## Links

- Agent Client Protocol: https://agentclientprotocol.com/overview/introduction · tool calls https://agentclientprotocol.com/protocol/v1/tool-calls.md · content/mentions https://agentclientprotocol.com/protocol/v1/content.md
- Claude ACP adapter: https://github.com/agentclientprotocol/claude-agent-acp · Codex ACP: https://github.com/zed-industries/codex-acp
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/typescript.md · checkpointing https://code.claude.com/docs/en/checkpointing.md
- HyperFrames: https://github.com/heygen-com/hyperframes · CLI skill https://github.com/heygen-com/hyperframes/blob/main/skills/hyperframes-cli/SKILL.md
- Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- open-pencil: https://github.com/open-pencil/open-pencil · ZSeven openpencil: https://github.com/ZSeven-W/openpencil · open-design: https://github.com/nexu-io/open-design · opendesign skills: https://github.com/manalkaff/opendesign
- Figma generative plugins: https://developers.figma.com/docs/figma-mcp-server/generative-plugins-and-shaders/ · write to canvas https://developers.figma.com/docs/figma-mcp-server/write-to-canvas
- tldraw agent: https://tldraw.dev/starter-kits/agent · Raycast AI extensions: https://developers.raycast.com/ai/learn-core-concepts-of-ai-extensions
- Blender MCP: https://github.com/ahujasid/blender-mcp · Ableton MCP: https://github.com/ahujasid/ableton-mcp · Unity MCP: https://github.com/CoplayDev/unity-mcp · Unity AI Assistant checkpoints: https://docs.unity3d.com/Packages/com.unity.ai.assistant@1.7/manual/checkpoints-reference.html
- Krita AI Diffusion: https://github.com/Acly/krita-ai-diffusion · Excel Agent Mode: https://techcommunity.microsoft.com/blog/excelblog/building-agent-mode-in-excel/4457320 · Descript Underlord: https://www.descript.com/blog/article/underlord-ai-video-editor-primer
- Photoshop AI assistant: https://www.engadget.com/apps/adobes-new-photoshop-ai-assistant-can-automate-repetitive-tasks-120032017.html · Premiere: https://news.adobe.com/news/2025/04/new-ai-innovation-in-industry
