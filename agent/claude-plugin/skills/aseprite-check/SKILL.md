---
name: aseprite-check
description: Check the open Aseprite sprite for pixel-art problems and fix the errors. Use when the user asks to check, lint or clean up a sprite.
---

1. Call the aseprite `check` tool on the active sprite (pass `layer` or `frames` if the user named them).
2. Fix every error with `execute_lua`, one undo step per fix, following the `fix:` line of each finding.
3. Leave warnings that look deliberate (a highlight pixel, a held frame) and say why.
4. Run `check` again and `snapshot` the result. Report what you fixed in two or three sentences.
