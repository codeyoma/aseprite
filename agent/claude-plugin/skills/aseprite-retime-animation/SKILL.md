---
name: aseprite-retime-animation
title: Retime an animation
description: Change frame counts, durations, tags and loops of the animation in one step through the timeline text.
category: Animation
triggers: [retime, fps, frame rate, ping-pong, slower, faster]
tools: [get_timeline_text, apply_timeline_text]
---
# Retime an animation

1. Read the timeline with `get_timeline_text`.
2. Edit the text for what the user wants (for durations that read well, see `rule:anim.ticks` and `rule:anim.timing`): `fps N`, `frame A-B duration Nms`, tag ranges and directions (`forward`, `reverse`, `ping-pong`), `repeat=N`. Keep every tag you don't change.
3. If the change removes frames or tags, call `apply_timeline_text` with `plan: true` first and tell the user what will change.
4. Apply it with one `apply_timeline_text` call.
5. If frames were added, they copy the last frame: say so, and offer to draw them.
