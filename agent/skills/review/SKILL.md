---
name: review
title: Review with fresh eyes
description: Have finished work judged by a critic that never saw the brief, then fix it in at most three small rounds, each kept only if it wins a blind A/B comparison.
category: Cleanup
triggers: [critique, fresh eyes, review this sprite, review my sprite, rate my sprite]
tools: [critique, diff_visual, ab_compare, read_pixels, write_pixels, execute_lua, undo, check, snapshot, read_guide]
---
# Review with fresh eyes

You know what you meant to draw, so you see it whether or not it is there. A critic that never saw the brief does not. Polishing can also make good art worse, so a fix stays only when a second blind critic prefers it.

**When:** sizable work only, since every round costs two critic calls. Review a sprite of 24x24 px or more, an animation of 4 frames or more, or anything that took you 10 or more edit steps. For smaller work run `check` and look at a `snapshot` instead. Other skills (drawing, animating, shading) can end with this one when the result is sizable.

## 1. Critique
1. Run `check` first and fix its errors yourself: a critic should not spend its read on orphan pixels.
2. `critique` with at most a one-line `what` ("a 32x32 knight walk cycle"). Never pass the brief, the user's words or what you changed: the critic must judge what the picture shows. For an animation pass the `tag` (the critic then also gets the trails view and the measured motion) or `frames`.
3. Read the result: a cold read, a score out of 10, and findings tagged BLOCKING, WORTH FIXING or NOTE, each citing a rule (`read_guide` the rule id when the finding is unclear). A finding marked "unknown rule id" is the critic's own opinion: weigh it yourself.
4. **Ship** at 7/10 or better with nothing BLOCKING: report the score and the findings you left, and stop. A cold read that does not name your subject is the most important finding: the picture does not say what you think.

## 2. Fix rounds (at most 3)
Each round:
1. **Checkpoint:** `diff_visual { save: "review-<n>" }` (the bridge keeps a copy of every layer).
2. **Fix, don't redraw:** fix the BLOCKING findings, or when none is left the critic's first fix. Nothing else: no general polish. `read_pixels` the region the finding names, change those keys, `write_pixels` them back, in one edit step if you can so one `undo` reverts it. Change at most 25% of any layer's opaque pixels.
3. **Blind A/B:** `ab_compare { checkpoint: "review-<n>", what: <the same line> }`. It runs the fix guard first: a fix that changed more than 25% of a layer's opaque pixels is refused, so undo it and make a smaller one. A motion fix (a part moved, rotated or re-spaced, a frame re-drawn between its neighbors) passes `motion: true`: the guard then accepts a layer that keeps its size in every frame, and the critic sees the whole tag. Otherwise a fresh critic sees the checkpoint and the canvas as A and B in a random order and picks one; the result says which won.
4. **Keep the winner:** when the fix wins, keep it. When the checkpoint wins or it is a tie, `undo` the fix steps and `diff_visual { checkpoint: "review-<n>" }` to confirm nothing changed since the checkpoint.
5. `critique` again (with the same `what`) for the next round's findings. Ship as in step 1.4.

Stop after three rounds, or after two rounds in a row that the comparison rejected. If a BLOCKING finding is still standing or the score is under 7, say so and ask whether to run more rounds; do not stop silently. Scores from different critics are not on one scale: decide by `ab_compare`, not by comparing scores.

## 3. Report
For each round: the finding you fixed, what you changed, the guard's numbers and which version `ab_compare` kept. Then the last score and the findings you left. Do not edit after the last critique: anything changed afterwards has not been judged.

Then: `export-game` when the work is for a game.

Adapted from aseprite-ai-artist's pixel-critic agent and studio skill, step 8 (MIT, https://github.com/with-pebbly/aseprite-ai-artist).
