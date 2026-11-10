---
name: make-variations
title: Give me variations
description: Draw several versions of something (colors, shapes, poses) side by side so the user keeps the one they like.
category: Drawing
triggers: [variations, options, versions]
tools: [execute_lua, propose_variations]
---
# Give me variations

1. Decide how the versions differ (color, shape, pose, detail) from the user's request; default to 3.
2. Build each candidate in `execute_lua` with `variationLayer(task, i)` for i = 1..n, using the sprite's palette. Keep them the same size and position so they compare well.
3. Call `propose_variations(task)`. The user keeps one in the panel or discards them; don't pick for them.
4. Reply with one line per version saying how it differs.
