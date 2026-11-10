# Implementation notes

One short entry per change: how it works, why it was done this way, and where it sits in the architecture. Newest first. These notes are for future refactoring; terms are in `GLOSSARY.md`.

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
