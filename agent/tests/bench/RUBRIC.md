# Benchmark rubric

A benchmark's criteria are pass/fail: they say whether the run did what the prompts asked, checked through the tools. They cannot say whether the result is good art. This rubric does that, on five axes scored 0 to 4 against fixed anchors, so that two judges looking at the same run give close scores.

`run_bench.mjs` asks a judge for these scores after each benchmark and stores them under `judge` in the run's `generation.yaml`, with `overall` (the mean of the scored axes).

## How the judge works

- **Blind.** The judge gets the request (the prompts without the `/skill:` prefix) and three images under neutral names: the filmstrip, the last frame enlarged and the last frame at 1x. It is not told which provider or model drew the art, and the files it sees do not say.
- **Never the artist.** The judge is the other provider by default (`--judge`); the runner refuses the provider that drew. Each judge is a one-shot CLI call (`claude -p` or `codex exec`) run in an empty temporary folder, so it cannot read the repository or earlier runs.
- **Lower anchor when unsure.** A result between two anchors gets the lower score unless every part of the higher one holds.
- **Motion only for animations.** A benchmark marked `animated: false` gets `motion: null`, and the mean leaves it out.
- **Re-judging** an existing run replaces its `judge` block: `node agent/tests/run_bench.mjs --rejudge <run dir>`.

## Axes

### readability: what reads at 1x

| Score | Anchor |
|---|---|
| 0 | You could not say what it is without being told. |
| 1 | You can tell what it is, but important parts run together (limbs into the body, a prop into the character, the subject into the background). |
| 2 | It reads at a glance; one or two important parts are lost or muddy at 1x. |
| 3 | Every important part reads at 1x, and the silhouette alone tells you what it is. |
| 4 | It reads instantly at 1x and leads the eye: the focal point is where you look first. |

### form: light, volume and material

| Score | Anchor |
|---|---|
| 0 | Flat fills, or shading that no single light direction explains. |
| 1 | There is a light direction, but it is applied unevenly, or the shading is pillowed (darkening toward every edge) or plain brightness steps. |
| 2 | One consistent light; the main forms have volume, but different materials look the same. |
| 3 | Consistent light with ramps that shift hue, not only brightness; materials (cloth, metal, skin, stone, foliage) read as different. |
| 4 | As 3, with deliberate secondary light (bounce, rim, glow) that adds depth without adding noise. |

### palette: color discipline and clean pixels

| Score | Anchor |
|---|---|
| 0 | Colors clash, or the image mixes pixel sizes or styles; noise everywhere. |
| 1 | One style, but sloppy: stray pixels, jagged lines, banding or accidental anti-aliasing throughout. |
| 2 | The main forms are clean; a few stray pixels, jaggies or uneven outlines remain. |
| 3 | Clean, deliberate clusters; outlines and dithering are used the same way everywhere; the palette works as a system of ramps. |
| 4 | Every pixel looks placed on purpose: a pixel artist would not clean anything up. |

### motion: timing, spacing and arcs (animations only)

| Score | Anchor |
|---|---|
| 0 | The frames do not make a movement: jumps, pops, or nothing readable changes. |
| 1 | The movement reads but is mechanical: even spacing, even timing, parts sliding in straight lines. |
| 2 | Key poses read and timing varies, but in-betweens slide, volumes change size, or nothing follows through. |
| 3 | Clear anticipation, action and follow-through (or a smooth loop), with arcs and easing; secondary parts lag and settle. |
| 4 | As 3, with weight and intent: holds, smears or impact frames land exactly where they should. |

### fit: does it answer the request

| Score | Anchor |
|---|---|
| 0 | It ignores the request or answers a different one. |
| 1 | It answers part of the request; a main point (subject, count, style, layout) is missing or wrong. |
| 2 | Every main point is there, but details the request named (direction, size, colors, states, timing) are off. |
| 3 | It does everything the request asked, as asked. |
| 4 | As 3, and the choices the request left open are made well: you would not ask for a redo. |

## Credits

The idea of separating pass/fail compliance from a blind craft score, and the shape of the axes and anchors, come from aseprite-ai-artist (MIT): `gallery/RUBRIC.md` and `docs/evals/benchmarks.md` in https://github.com/with-pebbly/aseprite-ai-artist. The axes here are reworded and regrouped: `palette` folds in their cohesion axis, and `fit` replaces their appeal axis because each benchmark has a written request to score against.
