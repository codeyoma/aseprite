---
name: check-sprite
title: Check and fix pixel art
description: Find pixel-art problems in the open sprite (off-palette colors, orphan pixels, semi-transparency, empty cels, timing outliers) and fix the errors.
category: Cleanup
triggers: [lint, clean up, cleanup]
tools: [check, execute_lua, snapshot]
---
# Check and fix pixel art

1. Run `check` on the active sprite. If the user named a layer or frames, pass `layer` / `frames`.
2. Fix each error with `execute_lua`, one step per kind of problem, following the finding's `fix:` line. Use palette colors only.
3. Leave warnings that look deliberate (a single highlight pixel, a held frame) and say why.
4. Run `check` again and `snapshot` the result.
5. Reply with what you fixed and what you left, in two or three sentences.
