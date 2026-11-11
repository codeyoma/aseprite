# Implementation notes

One short entry per change: how it works, why it was done this way, and where it sits in the architecture. Newest first. These notes are for future refactoring; terms are in `GLOSSARY.md`.

## Juice and the sprite-effect core (#104)
- **How:**
  - `sprite_fx/curves.ts` has Penner's easings, a closed-form damped spring, a decaying bounce and a seeded shake.
  - `sprite_fx/raster.ts` has the pixel-safe warp (inverse map over an 8x Scale2x upscale) and the hit flash.
  - `sprite_fx/juice.ts` turns an effect into one warp per frame. `juice_tools.ts` reads the layer, warps, and writes through `sprite_fx/write.ts`.
  - `put_images` items accept `hide_source` (protocol v36), so the copy layer and the hidden source land in one request.
- **Why:** the user bought CodeManu's FX tools and asked for the same kinds of effects built in, from public algorithms (research in `docs/fx-algorithms-research.md`). Juice comes first because smears and pipelines reuse its core.
- **Architecture:** every sprite effect writes a copy layer with the source hidden. Frames the effect does not touch hold a copy of the source, so hiding it changes nothing else. Scale2x copies existing pixels only, so transforms never add colors. RotSprite and Scale2x reference code is AGPL/GPL, so both are reimplemented from their descriptions.

## Character motions, ask_user, later layered rounds, image cards in the chat
- **How:**
  - `generate_character` writes later rounds into the character's group. It stores the character in the pixel spec (`characters.<name>`: reference layer, palette, layers, base frame, master sheets). A later round finds the existing part layers by name inside `AI: <name>` and writes into them. It reuses the reference layer and palette, sends the base pose and the last master along as references, and adds only the new layers.
  - Layers can be `effect: true` (slash trails, sparks). Their prompt draws only the effect, where it belongs, with blank panels allowed, and they skip alignment.
  - `inbetweens: true` marks a round of in-betweens, which starts no new motion stage.
  - `ask_user` (`core_tools.ts`) posts a "question" chat event (`choices`, protocol v35) through a per-chat `post` in the tool context, then tells the agent to end its turn. The panel draws the question with option buttons. A click sends the option as the user's next message; typing an answer also works.
  - The skill `character-motions` covers the workflow:
    - one sprite per character, a base pose, then each motion appended as a tag;
    - for a new character, ask how finely to split it and wait;
    - up to 9 frames in one round, one image per layer holding every frame;
    - longer motions: 8 keys first, then the in-betweens in rounds of up to 9.
  - Sent images show under the user's bubble as small cards: the entry keeps `images` (label, path), which survive a relaunch. Thumbnails are cached in the panel and loaded by a timer outside paint. Hovering a card shows the image large; a click opens it in Aseprite. The bubble no longer lists "Attached:" lines.
- **Why:** the user's design for animations: a master, then the parts, weapons, clothing and effects as layers. Each layer's image holds all of its frames, cut apart. Motions are tagged ranges built on a base frame. The user also asked that the agent ask how finely to split a character and wait, and that sent images be visible in the chat. In a live run, "a girl with a katana swinging the sword" led the agent to read character-motions, call ask_user and stop.
- **Architecture:** the character record lives in the existing pixel spec. `ask_user` reuses the chat event stream and the panel's button hits. `Panel.entries()` now passes `images`, `options` and `answered` to tests.

## Agent permission requests are allowed without asking
- **How:** `Panel.askPermission` picks the request's allow option (allow-always when offered, else allow-once) and answers it without a dialog; the log says "allowed automatically". That covers ACP tool permissions and the bridge's own questions (`ChatRunner.ask`: the image generator). AI Agent > "Ask Before Agent Actions" (plugin preference `askPermissions`) brings the dialogs back. The live harness turns asking on, since tests answer the dialogs; `permission_live` also checks the automatic path.
- **Why:** the user asked for every agent request to be allowed: the dialogs interrupted work.

## Layered characters from the image generator (#103)
- **How:**
  - `generate_character` (`concept_tools.ts`, `layered.ts`) asks once for the whole batch. It then runs one job, in two steps.
  - First, a master sheet: the whole character in every key pose, one square panel per pose on a grid (`gridFor`: 1x1, 2x2, 3x2 landscape, 3x3). Frame 1 of an existing sprite goes along as the reference.
  - Then one image per part layer (default 8: far arm, far leg, torso, near leg, head, eyes, hair, near arm), with the master attached (`codex exec --image`): only that part, whole even where covered, at the same place in every panel. Up to 3 run at a time, and a failed layer is tried once more.
  - When the job is done, the call that sees it applies the result. Every sheet is cut with the same grid and fitted to the canvas the same way (`readConcept`), and snapped to one palette quantized from the master. Each layer panel is shifted up to ±3 px to fit inside the master panel's silhouette (`alignToMaster`); over 35% outside is reported as misaligned.
  - Everything goes in one `putImages`: the master on a hidden, locked reference, the parts in draw order. Then `execute_lua` groups the parts under "AI: <name>" with plain part names, and the pixel spec gets the walk limbs and, with a tag, the motion stage at "keys".
  - The image generator now takes reference images, and finds its PNG only in its own Codex thread folder (several run at once). `ImageJobs` runs a batch as one job with progress.
- **Why:** the user wants characters built from parts: each part on its own layer, each layer generated once with all its frames. Parts keep their size across frames, which the judges' "limb lengths change" complaint asks for. The user's decisions: rough layers by default, one consent, 3 at a time, one palette, key poses only (the stage gate stays), whole hidden parts, ±3 px alignment, one retry, a group plus a hidden reference. A test showed Codex's generator, given the knight as a reference, drew "only the plume" at the same place and size.
- **Architecture:** `layered.ts` holds the prompts, grid, pool and alignment as pure functions, tested with a fake generator. The tool reuses the concept panel fitting and the pixel spec. The live test `layered_live.mjs` uses about 9 real images and isn't in "all".

## Motion stage gate: keys first, checked, then in-betweens (#99)
- **How:**
  - `motion_stage` (`animation_tools.ts`) writes a stage into the pixel spec (`motion`: tag, keys, stage, walk). `keys` starts it; for a 6-frame walk the keys default to 1, 3, 4, 6 of the tag.
  - In the extension, `H.call` wraps every scoped-write request (`execute_lua`, `write_pixels`, `put_images`...) with `motion_gate.lua` while the stage is "keys". It snapshots every cel of the tag's other frames, runs the request, and undoes it when one of them changed, naming the frame and the keys.
  - Frames outside the tag stay free. Adding frames doesn't open the gate (the locked frames keep their numbers). Removing frames skips the comparison.
  - `advance` needs every key drawn and distinct from the key before it, and for a walk `walk_check` ok (the same `measureWalk`). `done` ends it.
- **Why:** skill text didn't make the agent draw keys before in-betweens; it drew the whole cycle in one Lua call. Codex's review: a refusal inside one tool is bypassed through `execute_lua`, so the gate sits where every edit passes, like the sub-agent scope guard (snapshot, run, compare, undo).
- **Architecture:** the stage reuses pixel spec storage, so no protocol change. The gate reads the sprite property per edit (a small JSON string; `json.decode` gives userdata, not tables). The tests are `motion_gate_test.lua` and the motion_stage unit tests.

## Stable instance: its agent home is pinned to its own bridge
- **How:** `stable.mjs install` writes `pinned: true` into `~/.aseprite-agent/bridge.json`. A bridge started with that home whose own path differs (`homeBelongsToAnother`) neither records itself there nor publishes `session.json`; it logs why. Its stdio tools still work.
- **Follow-up:** the extension never used the pin. `json.decode` gives userdata, and `bridge_connection.lua` required `type(info) == "table"`, so it fell back to a bridge path remembered from an old session (the dev checkout). The pinned dev bridge then refused to publish, and the chat said "The bridge did not start". The check now accepts userdata. A `--daemon` started in a home pinned to another bridge starts the pinned bridge and exits, which also repairs installs whose extension still has the old check.
- **Why:** a `claude` CLI session in the repository ran the dev bridge as its MCP server without `ASEPRITE_AGENT_HOME`. Every bridge records its path in `<home>/bridge.json`, so that session pointed the user's Aseprite AI at the dev checkout, and Aseprite AI started dev code as its daemon.

## Walk check: near leg lighter than the far leg (#99)
- **How:** at each contact, `legLightness` takes the near leg's mean OKLab L (its mask, from the hip down) and the mean L of every other opaque composite pixel under the hip (the far leg). `judgeWalk` makes it an error when the near leg is less than `MIN_DEPTH` (0.12) lighter. It's skipped when there are fewer than 3 far-leg pixels (the far leg hidden). `walk_check` prints both values.
- **Why:** every benchmark run so far drew the legs in #3c3c5a (near) and #1d2b53 (far), ΔL 0.07. The judge read the arm against those legs as same-side in some runs and opposite in others (run 12 opposite, run 13 same-side, with the same leg colors). A pairing a judge gets right by chance isn't readable. A measured threshold turns that into a fix with a number. 0.12 lets a mid grey-violet near leg (#6a6a90, ΔL 0.24) against the navy pass.

## Motion review: does the walk read the way it is drawn (#99)
- **How:**
  - `motion_review` (`critic.ts`) measures the walk's contacts with `measureWalk`, the code `walk_check` uses, which now sits in `walk_check.ts` and is shared.
  - It shows a fresh critic only the two contact frames, side by side and enlarged on a checker, with the facing. The critic gets no measurement, layer names or brief.
  - The critic answers, per frame, the question a player answers: which arm it notices, which leg belongs to that arm's side, which way each points, what made it pair them, and whether it is sure (`parseMotion`).
  - `compareMotion` lists every finding with the fix (the same depth cue for the near arm and near leg). The findings are: an arm seen swinging with its paired leg; no pairing, or an unsure one; a pairing that differs from the measured near limbs.
  - Statuses: ok, readability, or errors (walk_check's measured errors come first). Critics can't call it (`AGENT_TOOLS` in `server.ts`).
- **Why:** after walk_check, the benchmark's walks were right by their layers, but the judge still saw the arm swing with the same-side leg: it took the dark far leg for the near one. A measurement can't see that; a viewer can. The first prompt asked which leg reads as near and said "usually the lighter one". That matched the agent's design, so Claude passed both runs that the judge failed. The prompt now asks how a player pairs the limbs, and whether every cue agrees. On run 11's contacts (dark near arm, light near leg), Claude answered same-side or unsure 3 times out of 3. With only the near arm recolored to a light step, it answered sure and correct 3 times out of 3. The animate skill now says to give the near arm and near leg the same depth cue.
- **Architecture:** a pure prompt and parser, a pure comparison, and one tool on the existing critic session and contact-sheet helpers. The animate skill runs it after walk_check says ok.

## Walk limb check: arms opposite legs, measured (#99)
- **How:**
  - `walk_check` (`walk_check.ts`, the tool in `animation_tools.ts`) reads the near arm and near leg on the walk's two contact frames. Each limb comes from a part layer, or from colors within rows (the arm above the hip, the leg below); layers named like "near arm" and "near leg" are found without naming them.
  - Only the part connected to the limb's top row counts, so the far arm's hand in the same color doesn't skew it. The hand's mean x over the bottom two rows minus the shoulder's over the top two rows (the foot against the hip for a leg) gives a signed offset toward the facing direction.
  - Errors: the arm and the leg on the same side at a contact, or a limb on the same side at both contacts. A limb that is missing or within 1 px of straight makes the verdict "unverifiable", never ok.
  - The limbs are stored in the pixel spec (`walk`), so a later call needs no arguments. The benchmark's new `walk_check` criterion runs it that way: an agent that never named the limbs fails it.
  - The animate skill makes it a gate: a walk isn't done until `walk_check` says ok, on the colored keys and again after the in-betweens.
- **Why:** two benchmark runs with the key-pose skill text scored motion 2 like the baseline. Both drew the whole cycle in one Lua call, and both judges saw the arm swing with the same-side leg while the agent's own table said the opposite. The unit test uses that run's frames 1 and 4. Codex's review chose this measurable check first. Its other two suggestions are still open: a stage gate in the extension (one tool can't enforce stages, since `execute_lua` bypasses any tool's refusal) and motion observations in the critic.
- **Architecture:** a pure measurement module (`limbMask`, `fromTop`, `readLimb`, `judgeWalk`) behind one tool; `pixel_spec` storage is reused; the benchmark adds a criterion type and calls the tool.

## Mascot: a digging shovel that doesn't read as a gesture
- **How:** digging alternates two diagonal icons: `shovel` (a scoop, blade down-left) and `shovel_toss` (blade up-right with a clod flying). Neither has an upright stick.
- **Why:** the upright 5x5 shovel (a vertical line on a block) read as a raised middle finger. The first fix kept a "blade in a mound" frame, a short upright stick on a block, which still read as a finger raised from a fist.
- **Architecture:** icons stay 5x5 grids in `mascot.lua` `ICONS`; a frame can change its icon (`i`) like any other field.

## Image generator for art from scratch (#102)
- **How:**
  - `generate_image` (`concept_tools.ts`) asks the chat's user first through the panel's permission prompt (`ChatRunner.ask`: "Allow once" or "Deny"). A timeout or a stop counts as "Deny". After a "Deny", the same question returns no without asking until the user's next message.
  - Then it starts a job in `ImageJobs` (`image_gen.ts`), which runs one generation at a time and cancels after 5 minutes. `CodexImageGenerator` runs `codex exec` in the agent's own Codex home, in an empty temporary folder with a read-only sandbox. The instruction asks for one image with Codex's built-in image tool and for the path as JSON (`--output-schema`). The PNG must be inside that home's `generated_images` and newer than the job; otherwise the newest one there is used. It is copied to `<agent home>/generated`.
  - One call waits up to 45 s. If the job isn't done, the agent calls again with the job id. That keeps every call under a client's tool timeout (Codex's MCP default is 60 s), although a generation takes a minute or two.
  - `storyboard_to_frames` takes `draft: N`. In the same `putImages` write, it puts each panel, reduced to N colors with k-means over all panels, on an editable `AI: Draft` layer above the reference.
  - The concept skill now uses the generator by default. The user's own image model and "continue without" remain for a "Deny" or a failure. The skill also says what reworking the draft means: palette, outline, ramps, stray pixels and readability at 1x.
- **Why:** pixels written in code for a new design came out weak. The design work (proportions, pose, color masses) is what an image model does well, and the concept workflow already turned such an image into reference frames. Only the step "the user pastes the prompt into another app" was missing. Codex's review shaped the details:
  - consent is enforced in the bridge, not only in the skill;
  - the tool says it uses the user's Codex plan limits (image generation spends them 3–5× faster), not that it's free;
  - the child has no repository context and no Aseprite tools;
  - the draft is snapped by the dominant color per block, never averaged.
  - `recreate_from_reference` stays for upscaled pixel art; `storyboard_to_frames` already fits a large image to the canvas.
- **Architecture:** the tool context gains `ask` and `images`. `http.ts` gives both only to the lead agent's endpoints, bound to the calling chat (`?chat=`), so sub-agents and critics can't generate. `index.ts` makes one `ImageJobs` for the bridge. The live test `image_gen_live.mjs` uses one real generation, so it isn't in "all".

## Sprite animation workflow research

The [research note](sprite-animation-ai-research.md) compares fixed character references, editable poses, localized redraws, and timing controls. It maps those workflows to the existing Pixel spec, Animate skill, and Review views, with a benchmark that measures both motion quality and time to an accepted result.

## Codex review follow-ups: one write per multi-frame tool, intent routing, timing in A/B, key-pose animation (#98-#101)
- **How:**
  - #101: `transform_layer`, `rotate_layer` and `subpixel_move` build every frame first and write them with one `putImages`, which is one transaction and one undo step. A frame that can't be read fails before anything is written. `rotate_layer` rotates a frame listed twice once.
  - #100: `skillContext` ranks the matching skills (`skillScore`: trigger hits, longer phrases count more, plus `intents` words from the skill's frontmatter). The best one is the primary workflow; the others are only named, for `read_guide`. `/skill:name` loads that skill alone. Animate and Directions point at `parallel-frames` for splitting frames across sub-agents instead of repeating it.
  - #98:
    - Review checkpoints keep durations and tags. `timingChanges` lists what changed, so a timing-only fix is compared instead of "Nothing changed".
    - The A/B critic gets each shown version's timing (`describeTiming`) in the shown order, which keeps it blind.
    - The animate benchmark checks the walk tag only, with `maxWarnings: 0`, so an idle may hold a frame (`check` criteria take `tag`).
  - #99: the Animate skill blocks the key poses first:
    - the reference frame is kept, with landmarks for the ground row, hip height and support foot;
    - flat silhouettes of the contacts and passing poses (or anticipation, hit, hold) go on `AI: Keys` and are checked in the filmstrip;
    - then the keys are drawn in color, and the in-betweens last, each from both neighbors (onion), redrawing only what drifts;
    - a hold is a longer duration, never a repeated frame.
- **Why:** Codex's architecture and motion review: half-done multi-frame writes, every trigger match injected, timing invisible to the A/B, and motion scored 1-2/4 while the checks passed.
- **Left:** horizontal slip of a marked contact foot (needs a contact marker); isolated playback for the human judge; the benchmark comparison numbers for #99 are in the issue.

## Parallel chats, drafts that stay, Enter while typing Korean (#90 part)
- **How:**
  - Bridge:
    - `ChatRunner` keeps a turn per chat (`turns` map); `chat.stop`, permissions and `currentProvider` take the chat id.
    - `AcpRuntime` keeps a runner (agent process) per chat and conversation key (`runnerKey`), and stops agents idle for 15 minutes (`IDLE_MS`).
    - Each runner's MCP address carries `?chat=<id>` (`chatEndpoint`). `http.ts` reads it, tags every request's envelope `{ origin: "chat", chat }`, and binds sub-agents and critics to the chat (`SubAgents.forChat`), so their tool calls and steps belong to it too.
  - Extension:
    - `chats.lua` marks working chats (`chat.busy`). A message waits only for its own chat's turn; `nextToSend` takes every ready chat.
    - `Panel.handleRequest` routes a request to its chat's sprite: when that isn't the active tab it is made active for that one Lua call, then the user's sprite, frame and layer come back before anything is drawn. A request that opens or makes a sprite moves the chat there.
    - Step captures record the chat and sprite, and claims filter by chat. Turns that overlap on one sprite are marked mixed, and lose Revert, with a note: their undo ranges hold each other's steps.
  - Drafts: the prompt box's text belongs to `promptOwner`. It is saved before another chat's draft is shown, and the owner changes before the text is set: the box's change event used to save the empty text into the old chat.
  - laf (`codeyoma/laf` agent-ime): Enter during an IME composition commits the syllable and also reaches the text box. Before, the input method's commit marked the key as handled, so a second Enter was needed.
- **Why:**
  - The user opened several chats and saw the others stop: turns ran one at a time, and requests waited for their sprite's tab.
  - Korean input dropped the first Enter.
  - Switching sprites lost drafts.
- **Left for later (#90):** document-scoped handlers instead of making a sprite active for each call, which agent-written Lua can't be confined by; sprite worktrees for sub-agents.

## Dev and stable instances, updates, Windows
- **How:**
  - `ASEPRITE_AGENT_HOME` (bridge `session.ts`, extension `agentHome()`) and Aseprite's `ASEPRITE_USER_FOLDER` make an instance; `tools/instances.mjs` defines dev (this checkout's build, `~/.aseprite-agent-dev`, its own user folder, linked extension) and stable (`~/.aseprite-agent-stable`, default user folder and home, copied extension).
  - Live tests and benchmarks start and stop only the dev instance, by pid; their bridge uses the dev home.
  - `tools/release.mjs` moves `stable` to a tested commit with a tag.
  - `tools/stable.mjs` prepares (a worktree at `stable`, Aseprite rebuilt only when something outside `agent/` changed, bridge built) beside the running app, then installs (a copy of `build/bin`, the extension, `<home>/bridge.json`).
  - The panel's Check for Updates runs it through `update.*` bridge methods; the installer waits for Aseprite to quit.
  - Windows:
    - the daemon starts with `start "" /B`; `platform.ts` scans PATH and knows `.exe` and install folders;
    - the Codex auth file is copied where a symlink isn't allowed;
    - `npm test` and the Lua runner are Node scripts; LF everywhere (`.gitattributes`);
    - the saved-command store turns off `core.autocrlf`;
    - a `windows-latest` CI job runs the unit tests.
- **Why:**
  - The user's Aseprite and the agent's tests shared one app, user folder and agent home. A test bridge took over the user's Aseprite, and `--restart` killed it.
  - Builds can't be distributed (EULA), so updates build locally.
  - A full build of the stable copy took 2 min 23 s on this Mac.
- **Architecture:** an instance is two environment variables; everything else is derived from them.

## Fewer round trips, Chats module, fast paths, one owner per helper (#88, #89, #91, #92, #94)
- **How:**
  - #88: `execute_lua` takes `look` (true or "filmstrip") and `check`; the snapshot and the findings come back with the edit (`snapshotContent`, `checkContent` in core_tools.ts). The chat system prompt includes `guide/basics.md`, so a conversation no longer starts with `read_guide("basics")`, and it tells the agent to use look/check.
  - #89: `chats.lua` is a pure module that owns chats per sprite, queues, who runs next, the gate and rehoming. `chat_panel.lua` calls it and draws it. Developer mode moved to `panel_developer.lua`, the My Commands dialog to `commands_dialog.lua`. Tests: `chats_test.lua`, and `panel_load_test.lua`, which builds the panel with unknown globals raising errors (it catches the use-before-declaration that stopped the extension from loading).
  - #91 (Lua part):
    - Step capture counts changes by comparing rows of the raw bytes and walks pixels only in changed rows. The red diff image is made on first use. Capture is 0.75 → 0.07 ms per small edit at 64².
    - `check` keeps the palette in a set of packed RGB, keys the orphan grid by integer, and gives findings only to the 32 most used off-palette colors, plus one summary. Worst case at 256² with unique colors: 2.7 s → 0.46 s; palette art 469 → 251 ms.
  - #92:
    - `image.ts` owns `crop`, `cropClipped`, `shrink`, `countColors`, `recolor` and `filePalette`; the copies in attachments, concept, fx_tools, tool_inputs, pixel_tools, recreate_tools, dither, style and sheet_tools are gone.
    - `Document.infoOrNone()` replaces matching the "No active sprite" text.
    - Light layers: check skips layers that don't blend Normal; export also counts a glow layer set to Normal as light. The difference is intended and now documented at both.
    - Review checkpoints refuse a comparison on another sprite.
  - #94: removed the unreachable `sessionId` (older panels) and `context` (older extensions) branches of `chat.send`.
- **Why:**
  - Transcripts showed read_guide → execute_lua → snapshot → check → execute_lua → check per edit, at ~2.7 s per model call.
  - The panel was 1.8k lines with scheduling rules only testable live.
  - check and capture were the only Lua hot spots the profiler found.
- **Left for later:** the FX record domain module; native helpers in the fork (base64 decode for put_images, histogram and neighbor counts for check); validating bridge-method params from protocol.json.

## Lean agent sessions (#87)
- **How:**
  - Claude sessions get `settingSources: []`, `strictMcpConfig: true` and `ENABLE_CLAUDEAI_MCP_SERVERS=false` (`providers/agent_home.ts` `LEAN_CLAUDE_OPTIONS`). So there are no user settings, hooks, plugins, skills, CLAUDE.md, other MCP servers or claude.ai connectors; only the aseprite server the session passes.
  - Codex runs with a private `CODEX_HOME` (`~/.aseprite-agent/codex-home`). It holds a link to the user's `auth.json` and a `config.toml` with only the user's model keys (`CODEX_KEPT_KEYS`). `ASEPRITE_AGENT_CODEX_EFFORT` overrides the reasoning effort.
  - Warm start: `chat.warm` (sent when the panel connects and after each turn) has the runtime start the agent process and a spare session for the next new conversation (`AcpRunner.warm`, used by `openSession` without an id).
  - Ask/Plan → Agent: a conversation whose last turn was read-only gets `AGENT_AGAIN_NOTE` once. Codex's approval review had rejected Agent edits because of the earlier Ask note.
- **Why:**
  - Measured on 60 transcripts: model time is about 94% of a turn, and every call carried ~354k tokens from 503 tools (81 of them Aseprite's).
  - After the change, live transcripts show 17-56k tokens per call.
- **Architecture:** the provider adapters own the session profile (`sessionMeta`, `env`); `Runtime.warm` is optional, and only the ACP runtime implements it.

## Mascot: the new logo face and 56 moods driven by chat events
- **How:**
  - `mascot.lua` draws the new logo: a 12x13 white face with the top corners cut, eye bars at columns 3 and 8, and a blue-gray chin.
  - A mood is a few frames. Each frame can set: eye style (`open`, `half`, `closed`, `happy`, `sad`, `x`, `ring`, `wide`, `squeeze`, `down`, …, per eye or both), eye offset, chin shape (`smile`, `flat`, `big`, `frown`, `open`, `grit`), face offset, a small icon (about 40 pixel icons, colored by meaning), thinking dots, a progress bar or a scan line.
  - All 56 moods of the brief are in `Mascot.GROUPS`: Idle, Receiving, Thinking, Searching, Working, Connecting, Saving, Waiting, Verifying, Result, Requesting. Open eyes blink every 3.1 s.
  - `mascot_mood.lua` (pure) picks a chat's mood. Sends, chat events, holds and queue waits go in. It keeps a steady mood and short reactions:
    - acknowledge, or uploading with attachments, or remembered when the conversation resumes, then listening or reading;
    - thinking, which turns into deep thinking after 8 s;
    - per tool, a mood by name (`TOOL_MOODS`: check → checking, export → saving, execute_lua → building, delete → deleting, …), with a tool_pick flash, eureka after a long think, and loading after 3 s;
    - after a tool result: retry or flustered or confused on failures, found after a search;
    - need_approval, and asking when the reply ends with "?";
    - at the end: done, proud or celebrate (by edit count), apologetic when stopped, stuck, error.
    - Without a turn it cycles idle, look_around, wander and zone_out, and gets sleepy after 90 s; it stretches when woken.
  - The panel always draws the mood row at the bottom of the log, with a label ("Searching... 7s", "Ready"). Each chat has its own mood. The ticker runs every 0.1 s during a turn and every 0.25 s when idle.
  - Gallery: `docs/mascot_moods.gif`. Tests: `tests/mascot_test.lua`.
  - Fixed on the way: a bridge disconnect now ends the running turn ("The bridge disconnected during this turn"). Before, the chat stayed busy forever and every new message was queued behind it.
- **Why:**
  - The user asked for a mascot that shows what the agent is doing.
  - Moods are data, so a new one is a few lines, and the mood logic is unit-tested without drawing.
- **Architecture:** `mascot.lua` (look) and `mascot_mood.lua` (state) are both pure; `chat_panel.lua` only feeds events and the panel clock (`animT`, since `os.time` has whole seconds) and draws.

## Chats per sprite, several chats per sprite, one turn at a time
- **How:**
  - The panel keeps chats grouped by sprite (`chats[key]`, key `s<Sprite.id>` or `none`). Each chat has its own Conversation, Turns (over its own sprite), Composer (draft) and queue. `activate` swaps the panel's `conv`/`turns`/`composer` upvalues, so the drawing and send code stay as they were.
  - A tab strip at the top of the log shows the active sprite's chats: a dot on the running one, "+N" for queued messages, ✕ to close, + for a new chat. "New chat" now adds a chat instead of wiping. `sitechange` shows the active sprite's chats and drops chats of closed sprites, except the running one.
  - One turn runs at a time (`running`). A message for any chat waits in that chat's queue, and the next turn takes the chat on screen first, then the others by age. `chat.send` carries `chatId`; the bridge tags every event of the turn with it, and `Panel.onEvent` applies it to that chat's Turns even when the chat is not on screen.
  - Document binding: requests from the bridge's HTTP MCP endpoint (chat turns, sub-agents, critics) carry `origin: "chat"` in the JSON-RPC envelope, with a 5-minute timeout. The extension's gate (`Panel.gate`) holds them while the running chat's sprite isn't the active tab ("Waiting for its sprite's tab..."), runs them in order when you come back, and fails them when the turn ends or the sprite was closed. A chat request that makes another sprite active (create, open) moves the running chat to that sprite (`rehome`). Requests without an origin (stdio MCP clients, live tests) are never held.
- **Why:**
  - Every tool, including agent-written Lua, works on the active sprite, so before this a tab switch in the middle of a turn sent edits to the wrong sprite.
  - Codex's review: swapping `app.sprite` around each request visibly switches tabs, mixes undo histories and breaks step capture, and two turns on one sprite would interleave undo ranges. So turns stay serialized and requests wait for their sprite. Truly parallel turns need document-scoped handlers and per-chat ACP lanes (a later slice).
- **Architecture:** chat routing is `chatId` on `chat.send` and on events; document binding is the envelope `origin` plus the panel's gate in `bridge_connection.lua` (`gate`, `retryHeld`, `failHeld`). The protocol version is unchanged: both additions are optional fields.

## Working mascot; prompt queue with Send now and a pausing Stop
- **How:**
  - `mascot.lua` draws the Aseprite logo's face (14x15 pixels, from the logo's colors) in the "Working..." row. `Mascot.pose(t)` walks a fixed script of poses: rest, look up, look up-right with thought dots that grow, glance left and right, squint, bob. A blink every 2.7 s interrupts any pose. The label word follows the pose ("Thinking...", "Looking...", "Hmm..."). The panel's ticker runs at 0.1 s while busy and advances `animT`, because `conv:elapsed()` uses `os.time` (whole seconds).
  - Queue: while a turn runs, Enter or Send (labelled Queue then) runs `composer:decide` as usual, and a "send" result is pushed to `queue` instead of starting a turn. Queued rows show under the working row with Send now and ✕. When a turn ends (`turnEnded`), `Panel.sendQueued` takes the first one and refreshes its State block and changes (`Composer:freshContext`), since the document moved on. Stop pauses the queue (`Paused`). Send now moves a row to the front, unpauses, and stops the running turn, whose end sends it. New chat clears the queue.
  - `AsepriteAgent.queued/sendNow/stop` are for tests (`tests/queue_live.mjs`, `tests/mascot_test.lua`).
- **Why:**
  - A spinner looked frozen on long turns.
  - Users want to type the next instruction while the agent works. Agents can't take a message in the middle of a turn over ACP, so "Send now" is stop-then-send: the conversation keeps its context, and the new message steers it.
- **Architecture:** the queue lives in the panel (it already owns the draft and turn start); the bridge still runs one turn at a time and never sees queued messages.

## Import an animated file as frames (import_animation)
- **How:**
  - `import_animation` (in `sheet_tools.ts`) decodes the file with the same `aseprite -b --sheet` path as attachments (`asepriteFrames`). It then either opens a new sprite with `createAnimation` (durations from the file, the file's colors as palette when there are at most 256), or puts each frame on a new `AI: <name>` layer of the active sprite with one `putImages` call, from `frame` on. That call adds frames at the end, sets the filled frames' durations, and centers the frames unless `x`/`y` are given. It is one undo step.
  - The panel's + menu has "Import animation as frames..." (a file, "A new layer here" or "A new sprite", the first frame). It calls the new bridge method `import.animation`, which runs the tool with no agent turn and writes the result into the log. The agent can do the same from an attachment's `file` path. The import-sheet skill tells it to use `import_animation` for an animated file.
  - `importDecoder.decode` can be swapped, so unit tests run without Aseprite. The live test is `tests/import_animation_live.mjs`.
- **Why:**
  - Aseprite already reads every animated format and its frame times, so the tool only has to place frames. Doing that through `putImages` keeps the existing guarantees: one undo step, step capture, the operation policy.
  - A new bridge method is a compatible protocol change (an older bridge answers "method not found"), so the version stays 34.
- **Architecture:** the bridge method lives in `bridge_methods.ts` and uses `runTool` with `toolContext(link)`, the same seam MCP tool calls use.

## Cmd+V attaches the clipboard image; attachment cards above the prompt
- **How:**
  - The prompt's `onkeydown` gets the key event's modifiers. `Panel.onPromptKey(code, mods)` sees Cmd/Ctrl+V, and when the clipboard holds an image and no text (`clipboardHasImage`, read in `agent.lua`), it attaches the image and stops the key. The text box itself only pastes text.
  - Pending attachments are drawn as cards in a strip at the bottom of the log canvas (`paintCards`): a thumbnail on a checker, a short name (`short`: file name, "pasted", "selection", layer name, "frame N") and a ✕ that removes that one (`Panel.removeAttachment`, `Composer:removeAttachment`). The old "Attached: ..." label is gone.
  - `Attachments:thumbnail(a)` reads the image once at attach time (shrunk to at most 128 px) and keeps it on `a.thumb`. `readImage` in `agent.lua` uses `Image{ fromFile }`. An indexed or gray file (most GIFs) opens as a sprite, frame 1 is rendered to RGB, and the sprite is closed, because `Image{ fromFile }` drops the palette.
- **Why:**
  - Users paste screenshots with Cmd+V. Before this, nothing happened.
  - Reading a file inside `onpaint` fired app events that repainted the panel again, which ended in "C stack overflow". So thumbnails are read when the image is attached, never while painting.
- **Architecture:** clipboard reads and file reads stay in `agent.lua` closures passed to `attachments.lua`; `chat_panel.lua` only draws cached images.

## Attach images in any format Aseprite opens, and the clipboard image
- **How:**
  - `loadAttachments` (bridge) is now async. It reads each file's header (`sniffImage`: PNG/APNG, JPEG, GIF frame count, WebP VP8/VP8L/VP8X) and sends a still PNG, JPEG, WebP or GIF of 256 to 2048 px as it is.
  - Everything else goes through `asepriteFrames`: `aseprite -b <file> --sheet --data --format json-array`, cut back into frames in Node. `renderFrames` turns one frame into a PNG (pixel art scaled up nearest to about 512 px, large images box-shrunk to 1280 px) and an animation into a `contactSheet` with frame numbers, ms notes when timing is mixed, and the `filmstripLayout` zoom.
  - The block's label says what it shows ("animation, 6 frames of 24x24 px (durations ...), shown as a sheet ..."); `chat.send` puts that label into the message text.
  - The extension offers the same extension list (`Attachments.EXTENSIONS`), a "Paste image from clipboard" menu item and the "Attach Clipboard Image to Chat" command. `agent.lua` reads `app.clipboard.image` (Aseprite asks permission per script file); `attachments.lua` converts an indexed image to RGB and saves it.
  - `AsepriteAgent.clearAttachments()` was added for tests. The live test is `tests/image_attach_live.mjs`.
- **Why:**
  - Providers take only PNG, JPEG, WebP and still GIF, and see only the first frame of an animated GIF. Aseprite itself already decodes every format users have, and gives frame durations, so one decoder path covers them all with no new dependency.
  - A sheet with numbered frames and times is how the agent already reads animations (the filmstrip), so attached animations read the same way.
  - Tiny pixel art upscaled matches what panel renders already did (512 px).
- **Architecture:** the decoder is a `FrameDecoder` parameter, so unit tests inject frames and never need Aseprite; `asepriteBin` is imported lazily from `cli.ts` to keep `attachments.ts` free of the CLI's imports.

## Low-scoring skills: tool fixes, sizing rules, a fairer judge (#82 follow-up)
- **How:**
  - `fx_overlay` takes `recipe` as well as `id`. Library-less effects (frost) can now land on the hit frame and extend past the tag; the recipe is stored in the FX record.
  - `make_ui` with a palette steps state shades along it (`paletteStep`: the nearest color in hue at least 0.05 Oklab L lighter or darker, avoiding a big chroma drop), instead of adjusting then snapping. Hover gets a lit frame when a lighter fill would leave the label under 0.25 L apart. Disabled is flat gray (`paletteDisabled`). The label shadow stays the darker step when the pressed bevel swaps. The new sprite gets the palette.
  - The filmstrip prints each frame's ms at the right of its label when durations differ (`contactSheet` `notes`; M and S glyphs).
  - Skills and rules gained the decisions the judge kept marking down: pixel-fx "size it before you place it" (reach, length, weight, ramp; `vfx.scale`/`vfx.timing` rows for novas), `anim.walk.limbs` (a per-frame near/far limb table), make-tileset edge lip and tuft variety, and the make-ui state check.
  - The runner saves `start.png` (the fixture before the request) as the first extra image, and the judge prompt says to score what was made on it. The recolor fixture is now a small character instead of a rectangle. The `skill` criterion accepts a header ending in the skill's name.
- **Why:** the judge's notes split into tool defects, missing guidance and benchmark unfairness:
  - Tool defects: hover snapping back onto normal, muddy pressed labels, and frost that could not be timed.
  - Missing guidance: tiny 3-frame effects, and arms on the wrong phase.
  - Benchmark unfairness: crude fixtures scored as the agent's form, and hit-stops invisible in a sheet.

  Each was fixed where it lives, not by prompting harder. Scores, baseline to now (Claude drawing, Codex judging):

  | Skill | Baseline | Now |
  |---|---|---|
  | pixel-fx | 1.2 | 1.8 |
  | animate | 1.6 | 2.0 |
  | recolor | 1.25 | 3.25 |
  | make-ui | 1.5 | 2.75 |
  | make-tileset | 2.0 | 2.75 |
  | shade-sprite | 3.25 | 3.5 |

  The remaining notes are craft (thin rings, a stiff walk).
- **Architecture:**
  - `fx_overlay` gained one optional input (registry fixture updated); no wire change.
  - Palette stepping lives in `ui_tools.ts` next to its only user. The filmstrip note is generic in `contactSheet`.
  - Tests: `fx_timing_tools.test.mjs` (recipe overlay), `ui.test.mjs` (palette states), `views.test.mjs` (notes), `bench.test.mjs` (start image, skill header).

## Benchmark judge sees the whole result; palette_swap adds its colors (#82 follow-up)
- **How:** `run_bench.mjs` now also saves `sprite-<n>.png` for each other non-empty sprite the benchmark made (a filmstrip when it has frames) and, when a benchmark sets `showLayers` (a regex; recolor uses `^AI: `), `layer-<n>.png` for each matching leaf layer alone. Each extra has a neutral description; 9-patch slices are listed as text (name, bounds, center), because snapshots don't draw slices. `bench.judgeImages` numbers the extras on from `image-4.png`, up to `MAX_EXTRA_IMAGES` (6). The list goes into `judge-images.json`, so `--rejudge` shows the judge the same images. `palette_swap` writes every variant and frame in one `putImages` call and passes the variants' target colors as its `palette`, so they are appended to the sprite palette.
- **Why:** the baseline judge saw only the main sprite's last frame. It marked the tile set and the panel missing (they were other sprites), and the green recolor wrong (only the top variant layer shows in the composite). That made the scores measure the camera, not the art. With the extras the judge's notes are about the art (recolor 1.25 to 2.5, make-ui 1.5 to 2.5, make-tileset 2.0 to 2.75). A rerun also showed `palette_swap` left new colors off the palette, so `check` reported off-palette errors whenever the model chose colors the palette lacked.
- **Architecture:** no wire change; the runner and `bench.mjs` gained the extras, and benchmarks gained the optional `showLayers` key. `palette_swap` uses the existing `put_images` palette append, so a swap is now one undo step. As a result, `export_palette_lut`'s base row includes the appended colors (the recolor eval expects 4 columns). Tests: `bench.test.mjs` (extras numbering and cap, `showLayers` validation), `palette_swap.test.mjs`.

## Claude gets TodoWrite in Agent mode (#78 live)
- **How:** Claude's Agent-mode tools are now `["Bash", "TodoWrite"]` (`providers/claude.ts`). Its to-do list reaches the panel as the ACP Plan.
- **Why:** the studio skill writes its chain as the plan. With only Bash, Claude had no to-do tool, so live runs never showed a plan.
- **Architecture:** each provider still owns its own tool list. The panel's Plan view already rendered ACP plan updates, so nothing changed there.

## Headless runner for batch work (#85)
- **How:** `extension/headless_runner.lua` runs under `aseprite -b --script`, builds `DocumentHandlers` from `protocol.json`, and loops on `io.stdin:lines()` (blocking reads work in this build's batch mode, so no pipe or polling is needed). Each request line `{id, method, params}` goes to `H.call` (or the runner's own `open`, `close`, `shutdown`); each reply is one stdout line prefixed with `\x1ease ` and flushed, binary results as base64 (`pixels.base64Encode`). `HeadlessLink` (`bridge/src/headless.ts`) spawns it, waits for the hello, checks the protocol version and implements `request` like `AsepriteLink`, so `ase --headless state|snapshot|check|timeline <files...>` runs the normal tools on it: open, run, close per file, one process. Before the first open it asks the newest live bridge (from `session.json`) for `GET /files` with the token; the live bridge gets them from `get_state`'s `openSprites`. No session or a closed port means nothing is open; a pre-#85 bridge (426) counts only when `/status` says no window is attached, otherwise headless refuses. Benchmark (`tests/headless_bench.mjs`, 20 sprites of 32x32x4 frames, M-series Mac): 20 separate `aseprite -b` runs 1421 ms, one runner 263 ms, 5.4x.
- **Why:** CI and batch asset builds paid Aseprite's start and the handler load per file, and had no state between calls. The mode is explicit, never a fallback, because a headless process works on disk files the user's window may also hold; that is also why it refuses files open in the live window and fails closed when it can't tell. The reply marker keeps Aseprite's own stdout lines from being read as replies. Adapted from aseprite-ai-artist's `headless/runner.lua` and ADR-0008 (MIT); ours reuses the Document Handlers directly instead of the plugin entry and leaves saving to explicit Lua. As always, builds of this fork are never distributed; headless mode needs your own build (`ASEPRITE_BIN` or `ASEPRITE`).
- **Architecture:** no protocol change; one new entry script in `extension/` (shipped with the package like the handlers), which `check_extension.mjs` now trusts next to `agent.lua` (entry scripts may touch files; no module may load one). `AsepriteLink` gained `GET /files`. Tests: `test/headless.test.mjs` (framing, refusal against stub bridges, `/files` with a fake extension; the real runner when `ASEPRITE` is set), `pixels_test.lua` for base64 encoding.

## Concept first: image-model prompt, pixel spec, reference frames (#79)
- **How:** `concept.ts` removes the background, cuts panels (a `{cols, rows}` grid, or "auto": `findSprites` counted per row, then an even grid), fits each panel to the canvas keeping its aspect ratio (bottom-aligned; "snap" is `pixel_grid.resample` with a cell of 1/scale, "nearest" samples the middle pixel), measures bounds, center, top and feet, and guesses color roles from a k-means of the image. `concept_spec` returns the skeleton JSON; `pixel_spec` stores it through `put_images`' new `spec` (sprite property aseprite-agent "concept.spec", get_state `pixelSpec`); `storyboard_to_frames` puts every panel on frame i of `AI: Reference` with the new per-image `locked`, hidden (or 25% opacity), plus the spec, in one `put_images`, so one undo step; `mismatch_regions` labels 8-connected reference-only and art-only areas per frame and sorts them by size. Compare's reference and art lookup moved into `views.referenceLayer` and `artWithout`, shared with `mismatch_regions`.
- **Why:** an image model designs well and pixels badly; the agent is the reverse, so the skill splits the job (aseprite-ai-artist's concept skill and ADR-0009, MIT; our prose and code). The measurements are the deterministic part, so the agent fills in only what needs eyes (poses, eyes, hands, deviations). Panels are fitted whole, not trimmed, because a figure's place in its panel is its place in the frame. The reference is hidden by default so snapshots, critics and export never see it, and locked so a stray write cannot land on it; Aseprite's own reference-layer flag is not settable from Lua. A locked new layer would otherwise become the active layer, so `put_images` restores the previously active one.
- **Architecture:** protocol 34: `put_images` gains `spec` and per-image `locked` (Lua, the fake and a contract scenario; get_state already reported `editable`, now in `LayerInfo` and the normalized contract state). Unit tests `concept.test.mjs`, the concept skill eval, the parity fixture's four new tools; live: `tests/concept_live.mjs`.
## Brief and studio skills: decide first, chain skills (#78)
- **How:** two text skills. `brief` has a table of six decisions (size, palette, view, light, outline, destination) with defaults and cited rules, and tells the agent to state them as its first message of the turn, ask only what truly blocks it and otherwise go on. `studio` routes a request through a table over our real skill names and guide topics (`concept` appears only as "(if installed)"), writes the chain as the plan (the agent's to-do tool, an ACP `plan`), reads each skill with `read_guide` at its stage, reviews, exports and ends with a Compromises list. Every built-in skill gained one `Then:` line. Their evals run `read_guide` on what the skill cites or routes to and check the SKILL.md itself: the decisions and an example with no question for brief; for studio, that every routed name exists and every built-in skill is reachable. `skill_then.test.mjs` checks each Then line; `studio_live.mjs` runs the knight-for-Godot request (`run_live.mjs` gives it 45 minutes and a temp dir).
- **Why:** open-ended requests failed on decisions nobody made (size, palette, where it goes), and long ones lost track of the steps. Stating decisions instead of asking costs no round trip; a plan the user can see and a closing compromise report make cut corners visible. Then lines let any skill hand off without studio. Adapted from aseprite-ai-artist's brief and studio skills (MIT); ours keep the turn going after the brief because the chat panel ends a turn on a question, and route only to skills we ship.
- **Architecture:** markdown only, no tool, wire or extension change: studio composes existing skills through `read_guide`, and the plan rides on the ACP plan updates the panel already shows. Triggers are phrases so common words never pull in the orchestrator.
## Skill benchmarks and a blind rubric (#82)
- **How:** six benchmarks in `tests/bench/*.json` (animate, shade-sprite, pixel-fx, recolor, make-ui, make-tileset), each a fixture with its own palette, two prompts and typed criteria (`skill`, `frames`, `size`, `tag`, `distinct`, `layers`, `palette`, `sprites`, `check`, `check_fx`, `lua`). `run_bench.mjs` drives them through `live.mjs` (`chat`, `lua`, `c.call`), reads facts per criterion (one Lua pass per sprite for size, tags, layers, repeated frames and opaque colors; the `check`/`check_fx` text), and lets `bench.mjs` decide pass/fail. It saves the filmstrip, the last frame (enlarged and 1x) and every sprite the benchmark opened as `.aseprite`, then copies the images as `image-1.png`... into an empty temp folder and runs the other provider once (`claude -p --tools Read` or `codex exec -s read-only --image=...`, prompt on stdin) with the request and the `## Axes` section of `tests/bench/RUBRIC.md`. `generation.yaml` comes from a small YAML writer (the bridge has no YAML package; benchmarks are JSON for the same reason); `--rejudge` replaces only its `judge:` block. `bridge/test/bench.test.mjs` validates the files, the blind prompt, run names, score parsing and the YAML.
- **Why:** live tests and skill evals prove a skill ran and its tools behave; they say nothing about whether the sprite is good, so skill changes could not be compared. Criteria stay deterministic so compliance is never a model's opinion, and craft is scored separately, blind and never by the model that drew, so a provider cannot grade itself. The rubric anchors and the compliance/craft split come from aseprite-ai-artist (MIT, credited in `RUBRIC.md`); we dropped their web gallery, submissions and composite score, and score `fit` against the written request instead of `appeal`.
- **Architecture:** test tooling only, beside the live harness: no bridge, wire or extension change. The pure half (`tests/bench/bench.mjs`) has no Aseprite or model dependency so `npm test` covers it; the runner only gathers facts and files. The benchmarks share one chat conversation, because `AsepriteAgent` exposes no New chat; criteria and files look only at sprites opened since the benchmark's fixture.

## Fresh-eyes critic with a blind A/B gate (#76)
- **How:** `critic.ts` adds `critique` and `ab_compare`. A critic is `SubAgents.open()`: an `AcpRunner` of the chat's provider (`ASEPRITE_AGENT_CRITIC=claude|codex` overrides it outside a turn, for live tests) in Ask mode on a new read-only endpoint `/mcp/critic` (read tools minus `critique`, `ab_compare`, `spawn_agents`), with `CRITIC_PROMPT` and a message holding only the image (one frame upscaled, or the filmstrip), a state summary, `rulesIndex()` and a `what` of at most 120 characters. The reply must be one JSON object; `askParsed` asks once more in the same session when it does not parse or validate, and findings citing ids missing from `ruleIds()` are flagged. `ab_compare` draws the A/B order (`ctx.random`, seeded in tests), records it, renders both versions in one sheet (A row over B row, new glyph B) and maps the critic's letter back. `diff_visual save` also stores a per-layer, per-frame copy in the bridge (all frames while layers x frames <= 256), which `ab_compare`/`critique` use as the before image and for the fix guard (more than 25% of a layer's opaque pixels changed, beyond 8 px, or a removed layer, refuses the round before any critic runs). The loop is the `review` skill.
- **Why:** an author grades what it meant to draw, and polishing can make good art worse (aseprite-ai-artist's pixel-critic and studio step 8, MIT; our prose and code). The critic runs through the same provider runner as sub-agents, so Claude and Codex both work and no API key or second client is needed; read-only by its endpoint and Ask mode, not by trust. A forced choice between two images is steadier than comparing scores from separate critics, and the caller cannot bias it because the order is drawn after its last move. The extension's checkpoint keeps only the active frame's composite, so the guard's per-layer copy lives in the bridge, with no wire change.
- **Architecture:** `ToolContext` gains `critic` (a `CriticRunner`, injectable: tests pass a scripted one) and `random`; `http.ts` serves `/mcp/critic` and gives critics and sub-agents no runner, so critics cannot start agents. No protocol or extension change; the parity fixture only gains the two tools. Unit tests: `critic.test.mjs` (parsing, retry, ids, seeded order, guard, endpoint), `critic_acp.test.mjs` (the runner over the fake ACP agent), the review skill eval; live: `tests/critic_live.mjs`.
## Plugin hooks: look after editing, bridge status (#81)
- **How:** the plugin gained `hooks/`. `sync-plugin.mjs` (now reading the built `dist/`, so `gen`, `gen:check` and `npm test` run tsc first) writes `hooks.json` and `edit-tools.json`: the PostToolUse matcher `^mcp__plugin_aseprite_aseprite__(...)$` and the list are every tool of kind `edit`, and the text is `LOOK_NUDGE` (`src/look.ts`). `look-nudge.mjs` checks the tool name again, keeps one marker file per session id in `${CLAUDE_PLUGIN_DATA}/look-nudge` (tmp when unset; markers older than a week are pruned) and prints `additionalContext` only the first time. `session-status.mjs` reads the port from `session.json`, asks `GET /status` with a 400 ms cap and reports connected or not; no session file, a dead or slow port, or an older bridge (426) give no output. The bridge's WebSocket now sits on its own `http.Server`, which answers `/status` (`{connected, aseprite, pid}`), 403 to web origins and 426 to anything else. The chat's system prompt ends with the same `LOOK_NUDGE`, then `check`.
- **Why:** agents report art they never looked at because a tool result says pixels changed; aseprite-ai-artist (MIT) showed a once-per-session nudge is enough and does not become noise. The tool list is derived so new edit tools are covered without touching the plugin. A TCP connect only proves a bridge is listening, and every Claude session starts one, so the hook asks the bridge whether the extension finished its hello. The port in `session.json` belongs to the newest bridge; at startup that can still be the previous session's bridge while Aseprite moves over, so the report is about Aseprite's reachability, not this session's own bridge.
- **Architecture:** hooks are plain Node scripts with no dependencies, outside the bridge, talking to it only through the session file and `/status`; the reminder text has one source shared by the plugin and ChatRunner. No wire protocol or extension change.
## Skills as MCP prompts and resources (#84)
- **How:** `skill_mcp.ts` registers, in `createMcpServer` (so stdio and every HTTP endpoint), one prompt per built-in or user skill from the Skill Catalog (guide topics left out): name and description from the skill, an optional `request` argument appended as "The user's request: ...", and the body in a `<skill>` block after a preamble that points at `read_guide("basics")` and the rules. `skill://<name>` resources come from one `ResourceTemplate("skill://{name}")` whose list callback reads the catalog, so they show in `resources/list` beside `rules://` and in `resources/templates/list`, with name completion. `/mcp/ask` gets the resources but no prompts. `skill_mcp.test.mjs` drives the SDK client over HTTP (`/mcp`, `/mcp/ask`, a user override in `ASEPRITE_AGENT_SKILLS`) and over stdio (the built bridge, with a temporary `HOME` so it does not record itself in the real `bridge.json`). `docs/mcp-clients.md` shows Cursor, VS Code, Claude Desktop and Codex configs that run the plugin's launcher.
- **Why:** the workflows reached only Claude Code (plugin skills) and the chat panel; prompts and resources are the MCP-native way to hand them to any client, from the same SKILL.md files, so nothing is copied. A template with a list callback instead of static registrations, because it lists in clients like static resources and picks up new user skills without a restart; prompt names are fixed per server (one per HTTP session, once per stdio run) but their text is read per request. No prompts on the read-only endpoint, since a prompt asks the agent to carry out a workflow that edits. Idea and config layouts from aseprite-ai-artist (MIT).
- **Architecture:** a thin layer over `guide.ts` (`allSkills`), next to `rules://` registration in `server.ts`; tools, the wire protocol and the extension are unchanged.

## Lospec palettes by name, with credit (#83)
- **How:** `palettes.ts` resolves a name in a fixed order (`lospec:<slug>` forces Lospec; else the user's, Aseprite's, an alias table that prefers Aseprite's copy, cached Lospec palettes, and finally Lospec by slug). A miss fetches `https://lospec.com/palette-list/<slug>.json` once and caches `{slug, name, author, url, colors}` in `~/.aseprite-agent/palettes/lospec/<slug>.json`; cached ones join `knownPalettes()` keyed by slug. `resolvePalette` (every `palette` input), `remap_to_palette`, `palette_from_image` (new `compare_with`) and the new `list_palettes` go through it and print "<name> by <author> (<url>)". Offline or a Lospec error gives a message that says what still works; `npm test` sets `ASEPRITE_AGENT_OFFLINE=1` so no test reaches the network, and `configureLospec` swaps the fetch and cache for tests.
- **Why:** fetch on demand, bundle nothing. Lospec's terms grant no licence for user-submitted palettes and forbid uses that "spider, crawl, or scrape" (https://lospec.com/terms-and-conditions); its API page describes "having your users type in a palette's slug" (https://lospec.com/palettes/api), which is this design. aseprite-ai-artist (MIT) bundles about 2000 Lospec palettes; we took only the idea of keeping each author and link. Aliases prefer Aseprite's copy so "make it Game Boy" works offline.
- **Architecture:** one module owns palette lookup (sync `findPalette` without network, async `resolveNamedPalette` with it); tools never fetch themselves. No wire protocol or extension change.
## Check expectations: layer frames, no overlap (#80)
- **How:** `check` takes `expect` (protocol 33, `object?`). `layer_frames {layer: frames}` reports, per layer, the checked frames with art outside the stated frames and the stated frames with no cel or an empty one; `must_not_overlap [[a, b]]` reports each frame where both layers have a pixel with alpha >= 128 at the same canvas position, with the count and up to 20 coordinates sorted by row. Both are errors with a fix line and the layer ids; an overlap finding names the second layer as `other`/`otherId`, which `formatCheck` prints as `L2 Weapon / L3 Head`. Layers resolve by id or name as the wire does; a group stands for its visible image layers, and a linked cel counts in each frame it shows in. The bridge checks the shape with zod (`checkExpect`); the handler checks it again (unknown keys, pairs, frame ranges, unknown layers) before any rule runs.
- **Why:** the rules so far judge pixels in general; they cannot know that the weapon belongs only to the strike frames or that it must never pass through the head. Letting the agent state that turns a visual judgement into a mechanical one it can fix by coordinates. The idea is the `expect` option of aseprite-ai-artist's `validate` (MIT); unlike it, findings group frames per layer, count every overlapping pixel instead of stopping at the first, and accept groups. Expectations run whatever `rules` selects, because the caller named them, and only on the checked `frames`.
- **Architecture:** all in `handlers_check.lua` beside the other rules, reusing `layerById`, `imageLayers`, `px.eachPixel` and `wire_params.resolveFrames`; the wire only grew one optional param. The fake document does not answer `check` and no contract scenario covers it, so the Lua tests (`check_test.lua`) are the reference.
## Pixel-art rules served on demand (#77)
- **How:** six chapters in `guide/rules/` (animation, characters, tiles, isometric, vfx, ui), each with ids on its headings (`{#anim.timing.walk}`), numeric tables, Mistakes, Review and ```` ```grid ```` templates in the `write_pixels` format. `rules.ts` parses them (chapters, rule sections, templates, `` `rule:<id>` `` citations); `read_guide` serves `rules`, `rules/<chapter>` and single rule ids, `list_skills` lists the chapters last, and `createMcpServer` registers one resource `rules://<chapter>` per chapter. The animate, make-tileset, make-ui, pixel-fx, make-directions and retime-animation skills cite rule ids instead of their own tables (animate reads `rules/animation` before planning); `sync-plugin.mjs` copies the chapters into the plugin's `aseprite-pixel-art/rules/`. `rules.test.mjs` checks list/read (tool and resource), that every cited id exists and that every template parses with `pixel_text.ts`; `rules_live.mjs` checks that `/skill:animate` reads the timing table.
- **Why:** the craft guidance was 24 lines plus a few per skill, and skills repeated each other's numbers. aseprite-ai-artist (MIT, credited in `guide/rules/CREDITS.md`) showed that subject chapters with numbers and templates beat improvisation; ours are trimmed, rewritten and retargeted to `write_pixels`. Stable ids let skills and the future critic (#76) cite one rule; a test keeps citations from going stale.
- **Architecture:** rules live under `guide/` so the package and plugin copies already carry them, but in a subfolder, which the Skill Catalog does not read: they are never triggers and never inlined, only read when asked. No wire or extension change; resources are static, one per chapter, read from disk on registration.

## Writable pixel grid (#74)
- **How:** a new wire request `write_pixels {layer, frame, x, y, rows, legend}` (protocol 32, kind scoped-write) takes the rows and legend `read_pixels` returns. The bridge tool checks the grid first (`pixel_text.ts`: ragged rows, unknown keys, bad legend colors, size; it also drops the `9| ` row labels and accepts the printed `Legend:` line), then the handler checks it again against the sprite (palette indexes, off-palette colors in indexed sprites, the canvas) before anything changes, and writes it in one `app.transaction`: the cel's image is replaced (cloned, or grown to cover painted pixels) and its position kept. `read_pixels` now never gives the transparent index as a key. The fake document answers `read_pixels` and `write_pixels`; `pixel_grid.json` runs on both; `pixel_grid_test.lua` round-trips RGB and indexed sprites; `pixel_grid_live.mjs` asks the agent to fix a 3-pixel defect.
- **Why:** agents edited exact pixels through `execute_lua`, which means translating rows they can see into drawing calls. Writing the rows back keeps the edit local and lets the next frame start as a copy of the last one, so limbs keep their size (aseprite-ai-artist, MIT, reports better results with its PixelGrid). Strict errors with row and column, because padding a short row would shift every pixel after the mistake and still report success. A wire request instead of Lua built in the bridge, so the operation policy, step capture and the sub-agent scope guard apply as for any other cel write.
- **Architecture:** the grid format is defined by `read_pixels` (RGB keys from the read's legend, indexed keys are palette indexes) and both halves live next to each other in `document_handlers.lua`. Request params decoded from JSON now tell objects from arrays by their keys (`plain()`), because an object with the key "1" answered like an array and lost its other keys; the contract runners encode `{ rows }` only under `rgba`.
## Review views: filmstrip, onion, compare; diff bounds (#75)
- **How:** `snapshot` takes `view`. `views.ts` reads one snapshot per frame (or per layer) through the document module at scale 1 and composes in the bridge: `filmstrip` uses `image.ts` `contactSheet` (now with `sheetGeometry`, a few letters and `flatten` for the checker) at the largest zoom whose sheet fits 1024 px, wrapping into balanced rows, never past 2048 px (only the first frames when even zoom 1 does not fit); `onion` blends the neighbors (mixed 60% toward red before, blue after, alpha 96/64/40 by distance, wrapping inside a tag) under the frame with `composeNormal`; `compare` puts the reference layer beside the shown layers without it, labelled REF and ART. `diff_visual`'s text now ends with `Changed bounds: x y w h (n of its w*h pixels)`. The animate skill reads the filmstrip (and an onion for a doubtful frame) before it reports; its eval ends with the filmstrip.
- **Why:** a vision model reads only a GIF's first frame, so the agent could not judge motion; the layouts follow aseprite-ai-artist's `look` tool (MIT, credited in `views.ts`). Composing in the bridge kept the wire protocol untouched while #74 changes it, and it works on the fake document, so the layouts are unit tested. Tints and fading match how Aseprite's red/blue onion skin reads.
- **Architecture:** a pure layout and compose module (`views.ts`) over the document module and `image.ts`; `core_tools.ts` only forwards to it when `view` is set, so a plain snapshot is the same single request as before. No protocol or extension change.

## Pixel FX skill (#73)
- **How:** `skills/pixel-fx/SKILL.md` walks the agent through pick (`list_fx`, `preview_fx`, tuning palette, seed, options and light; a recipe through `fx_from_recipe` when the library has nothing, with a frost nova as the worked example), variations, apply (`add_fx`, or `fx_overlay` on the attack tag with `hit_frame` and then `hit_stop`), a timing table, a "you see / fix" table, and finish (`check_fx`, `check`, `export_for_engine` with the glow sheet). Its eval runs list, add, overlay, hit-stop and `check_fx` on a 6-frame attack; `pixel_fx_live.mjs` asks for a frost nova on a mage's attack.
- **Why:** the FX tools (#68-#72) were usable one by one, but nothing told the agent the order, the timing conventions or how to fix a weak effect. The recipe example is ice because the library has none, so the live prompt exercises the recipe path. The eval uses `check_fx` because `check` runs in Lua, which the fake document does not have. Triggers are phrases ("slash effect", "magic effect") rather than bare words, because triggers match at word starts and "slash" or "magic" alone would fire on slash commands or the magic wand.
- **Architecture:** no code changed: the skill is data over existing tools, its plugin copy is generated (`npm run gen`), and the eval runs on the fake and, through `eval_live.mjs`, on Aseprite.

## check_fx counts opaque colors; FX live fixtures carry a palette (#72 live)
- **How:** the `check_fx` colors rule counts distinct colors at alpha >= `OPAQUE` only. The FX live fixtures set their own palette.
- **Why:** soft glow fringes made every library effect fail the rule. The live tests depended on the user's default palette, which is currently 256 blacks.
- **Architecture:** this is the same alpha policy as `check` and `image.ts` (`OPAQUE`). Live fixtures never rely on Aseprite preferences.

## FX recipes and the FX check (#72)
- **How:** `fx/recipe.ts` checks a JSON recipe with zod (`parseRecipe`: every problem by path) and compiles it into a pixelfx effect module whose `create` keeps "runs": a `Particles` system and `Lights` spawned at a cycle's start (emitter delays become the core's spawn delays; extra gravity and drag are applied to the run's own particles before each core step) plus rings (`Painter.ring`/`glowRing`), bands (core `band`) and shapes drawn from the run's own time in each phase's [start, end). Runs step themselves in exact 1/120 s steps; a loop pre-steps `ceil(span / duration)` runs one cycle apart and swaps the oldest for a fresh one every cycle. `fx_from_recipe` turns the recipe into a library-shaped entry (`recipeEntry`) and calls the code `add_fx`, `preview_fx` and `new_fx_sprite` now share (`placeFx`, `previewFx`, `fxSprite`). The FX record gained optional `recipe` and `render` text (protocol 31). `check_fx` reads each effect layer's pixels per frame through the document module and runs `checkFxLayer` (spill and one-shot-end re-render from the record; loop-seam and colors read the layer).
- **Why:** an agent can make or tune an effect without writing code, and the recipe stays reviewable and stored with the layer. Identical runs (same seed, same steps) make a loop's frame at t the same as at t + duration whatever particles cross the seam, which a single stepped sim cannot do. Recording `render` lets the check re-render a flipped, turned or reseeded effect as placed (default records stay as before). The seam rule reads the sprite's frames rather than the effect, so it also catches frame timings that cut a loop mid-cycle; the colors rule counts RGB at any alpha, so soft library effects (smoke, fire) warn by design and a test pins that.
- **Architecture:** the engine stays pure (`fx/`), the recipe compiler sits beside the library and uses only the vendored core; tools reach Aseprite only through the document module. The wire grew two optional text fields on the existing FX record (Lua, the fake and `contract/put_images.json` agree; 16384 characters each).

## FX export: origin pivot, meta.fx, glow sheet (#71)
- **How:** `add_fx`, `fx_overlay` and `new_fx_sprite` record `{ id, x, y, fps, loop, windupMs }` (origin in sprite pixels; windup = `fxImpact` ms) as the layer property `aseprite-agent` `fx` through a new `fx` param on `put_images` and `create_animation` (protocol 30), reported as `get_state`'s layer `fx`. `export_for_engine` (`fxExport`) pivots a sprite of effects only on its top effect's origin (an explicit `pivot` wins, a character keeps bottom-center), writes non-default pivots on each JSON frame (Phaser reads `pivot`), adds `meta.fx` (fps, loop, windup, origin, hits as 0-based frames with `freeze_ms`) to the JSON every engine gets, and with light layers (not Normal, or `AI: fx … glow`) writes `<name>_glow.png` placed like the color sheet (`pack`'s `also` trims to both) while composing the color sheet from the other layers in the bridge (`composeNormal`); `glow: "baked"` keeps Aseprite's render. The fake now blends Addition layers at any opacity as drawSprite's new blend method does.
- **Why:** per-layer records let several effects share a sprite and vanish with their layer; the origin (not the placement anchor) is pixelfx's attach point, so the game places the effect like pixelfx does. Recording goes on the existing write so it stays one undo step. Composing in the bridge avoids a wire change to `snapshot` (hiding layers would modify the document); per-frame pivots only when asked or from an effect, so existing Phaser exports keep their origin. The new contract scenario pins the fake's Addition blend to Aseprite's pixels (it matched on the first run).
- **Architecture:** the wire grew one optional record param on two writes (Lua, the fake and `contract/put_images.json` agree); the export decision is pure (`fxExport`, `composeNormal`, `composeLight` in `export.ts` / `export_tools.ts`) over the document module. `fxImpact` moved to `fx_tools.ts` (re-exported by `fx_timing_tools.ts`) so the placing tools share it.

## FX palette cap only for indexed sprites (#70 live)
- **How:** `fxPalette` appends the effect's colors to an RGB sprite's palette even past 256 entries (Aseprite allows it). Only indexed sprites snap past 256. `SpriteInfo` now carries `colorMode`.
- **Why:** live tests ran with a full 256-entry default palette, so the effect was snapped to black and `check` failed. An RGB palette does not limit what pixels can hold.
- **Architecture:** the decision stays in `fx_tools.ts` (`fxPalette`). The document module only reports `colorMode`.

## FX overlay and hit-stop (#70)
- **How:** `fx_timing_tools.ts` adds `fx_overlay` and `hit_stop`. `overlayPlan` (pure) maps a tag or a start-frame range to effect times: each frame (or, retimed, each ~1000/fps part of it, durations split so they add up) shows the effect at its start time, offset so the effect's impact (`fxImpact`: the first pixelfx act hit, else the busiest frame) lands on `hit_frame`'s first moment; a one-shot past the range is cut (tag) or extended by linked frames (start frame). `anchor_layer` takes the layer's opaque bounds at the hit frame once (centre, or bottom centre for ground; melee defaults to ground). `hitStopPlan` makes the contact frame `freeze_ms - shake.ms` longer and inserts max(2, round(shake.ms / 33)) shake frames whose moved copies alternate sideways with amplitude round(amp * (n-1-i)/(n-1)), ending at 0, so the total grows by exactly `freeze_ms`; the flash is a snapshot turned white and written into the contact frame. Both send one `put_images` with the new `insert` (frames after `after`, cels linked by Aseprite's LinkCels or moved copies for `shift.layers`; covering tags grow, later tags and hits move), `durations` and `hit` params (protocol 29); `get_state` reports `celLinks` per layer and `fxHits`.
- **Why:** one request keeps one undo step; `apply_timeline_text` cannot insert frames in the middle and is a request of its own. Linked cels (not copies) keep the character editable in one place after retiming; a moved cel cannot share cel data (position is part of it), so shake frames are copies. The shake comes out of the freeze because the issue fixes the total at `freeze_ms`. A tag defaults to cut because it is the action's length. The hit lives in a sprite property (frames have no user data in Aseprite) and is shifted by later inserts, so #71's export reads frame numbers that still match (`SpriteInfo.hits`).
- **Architecture:** timing is pure bridge code over the document module; the wire only grew generic timeline edits on `put_images`, modelled in the fake (a linked cel is one cel object in several frames) and pinned by `contract/put_images.json` against Lua. Placement, palette and layer naming are shared with `add_fx` (`fxPalette`, `placed`, `freeLayerName`).

## FX follow-ups: anchor, palette, light layers in check (#69)
- **How:** `add_fx` takes `anchor`: `ground` puts pixelfx's `meta.origin` (the feet) at x, y; `center` puts the effect's visual centre there, `visualCenter` (`fx/index.ts`): the alpha-weighted centroid of the frame with the largest alpha sum, from a render at the effect's own fps with the same options, seed and canvas (cached in `fxAnchorPoint`, the helper later placers share). Each catalog entry has a default (`defaultAnchor`: melee centred, tags ground/prop/ambient mean ground, three hand-listed), shown by `list_fx` and `preview_fx`. By default the colors on the Normal effect layer are appended to the sprite palette through `put_images`' new `palette` param (protocol 28), in the same transaction; past 256 entries they are snapped to it instead (`snapToPalette` gained `minAlpha` so faint pixels snap too), and `new_fx_sprite` sets its palette to the effect's colors (median cut to 256 and snapped when more). `check` skips the per-pixel rules on layers that do not blend Normal and lists them as `checked.lightLayers`.
- **Why:** the origin is the ground point, so a hit spark "at" a point flashed 20 px above it; the busiest frame's centroid follows the flash, where the union of all frames would follow sparks that fly off. The palette is appended inside `put_images` to keep one undo step. A glow is light added over the art, so off-palette and semi-transparent findings on it were noise (a hit spark gave about 1800); on the color layer a hit spark now checks with 0 errors and a few orphan warnings (sparks), which stay.
- **Architecture:** anchoring is bridge-side data plus one pure function; the wire only grew an append list (Lua, the fake and `contract/put_images.json` agree). Indexed sprites now convert images through the sprite's own palette in `putOne` (`toIndexed`): `Image:drawImage` maps through Aseprite's current palette, which misses entries added earlier in the same transaction.

## FX library and tools: list, preview, add (#69)
- **How:** 42 pixelfx effects are vendored as-is per category; `fx/library.ts` catalogs them from their own meta, and `fx_tools.ts` offers `list_fx`, `preview_fx` (contact sheet from `image.ts` `contactSheet`), `add_fx` and `new_fx_sprite`. `add_fx` maps sprite frames to effect times by their durations (`fxSchedule`; loops wrap), renders at those times (`renderFx` `times`, `canvas`, and `color` without light) and sends one `put_images` request (protocol 27): it adds frames (copies of the last frame), writes `AI: fx <id>` and its Addition glow layer (`blend_mode`, also on `put_image`), all in one transaction. get_state reports `blendMode`.
- **Why:** one request is the only way to get one undo step across many cels and new frames (each request is its own transaction and step capture; tools never write Lua), and it keeps the fake honest through the contract suite (`contract/put_images.json`). Effects that read the character (`onBody`), text effects four one-shots that do not end empty and a few large ones were left out; the melee effects' `actor: 2` is gallery-only, so the catalog drops it.
- **Architecture:** the engine stays pure (`fx/`); the catalog is data over the vendored modules; the tools reach Aseprite only through the document module (`putImages`). The fake refuses snapshots that would need non-normal blending instead of compositing them differently.

## Pixel FX engine: vendored pixelfx behind renderFx (#68)
- **How:** pixelfx's core JS (pinned commit, MIT) is copied as-is into `bridge/src/fx/vendor/` and built with `allowJs` (`checkJs` off). `fx/index.ts` exports `renderFx`, which steps an effect module on a fixed 120 Hz clock (step j ends at exactly j / 120 s), samples it at the requested fps and returns baked frames, the light buffer as `glow`, and an optional palette snap through `snapToPalette`.
- **Why:** vendoring keeps upstream behaviour exact and makes upgrades a reviewed diff; a hand port would drift. The exact clock makes 30 and 60 fps renders identical at shared times and makes a loop's frame at t = duration equal its frame at 0. Rig, actor, act, scene and font are cut (`NOTICE.md` lists the edits); text and actor effects throw.
- **Architecture:** a pure module with no document or wire access: only `index.ts` and its declarations (`vendor/core/index.d.ts`) are typed; our code stays strict. Three effects are vendored as the test set; the effect library and tools come later (#69).

## Refactor wave 3: tests that keep fakes honest (#86)
- **How:** the contract suite (`tests/contract/*.json`) replays the same wire requests against `fake_document.mjs` and the Lua handlers. `eval_live.mjs` runs the skill evals in Aseprite. Live tests split hard checks from soft checks (`soft()`). `npm run gen` is the single generator, and the Lua-tests stamp warns when the extension changed without a Lua run. The ACP fake's permission requests are checked against fixtures from the real agents.
- **Why:** before, the fake and Lua drifted silently, and model variance failed live tests. The contract work found six Lua bugs: tilemap snapshots, `mirror_frames` tags, hidden groups, swatch layers, palette case and `create_animation` leaks.
- **Architecture:** the document has two adapters (the fake and Lua) behind one contract, and tests are the seam. Evals are written once and run on both adapters.

## Refactor wave 2: bridge tool modules and panel controllers
- **How:**
  - `document.ts` owns every document write.
  - Shared tool inputs live in `tool_inputs.ts`.
  - Tools get a `ToolContext` instead of globals.
  - Core tools are split into `*_tools.ts` modules.
  - The panel's turn lifecycle moved to `turns.lua`, and its questions to `prompter.lua`.
- **Why:** skill tools wrote Lua or wire calls inline, and globals made tests order-dependent.
- **Architecture:** the Tool table lists modules once in `tool_modules.ts`. The document module is the only path from tools to Aseprite. The panel is a thin view over the Turn controller.

## Refactor wave 1: shared raster, operation policy, composer
- **How:**
  - `image.ts` holds the pixel helpers (bounds, trim, scale, stamp, PNG).
  - `protocol.json` kinds drive the read, write and scoped-write policy in `document_handlers.lua`, with handlers split into `handlers_*.lua`.
  - `composer.lua` turns Enter into one outcome.
- **Why:** there were 21 duplicated pixel helpers, and step capture and the scope guard each knew a different list of writes.
- **Architecture:** a single source of truth for the operation policy (the protocol) and for raster math (`image.ts`).
