---
name: parallel-frames
title: Work on many frames at once
description: Split a job over many frames (shading, redrawing, cleanup) across sub-agents that work in parallel, each on its own frames.
category: Animation
triggers: [every frame, all frames]
tools: [spawn_agents, snapshot]
---
# Work on many frames at once

1. Do setup that touches everything yourself first: new layers, palette colors, frame count.
2. Call `spawn_agents` with one shared `instruction` (self-contained: sub-agents don't see the conversation) and tasks of 1–2 frames each, at most 4 running at once.
3. When they finish, `snapshot` a few frames and fix anything that's inconsistent between frames.
4. Reply with what was done and how long it took.
