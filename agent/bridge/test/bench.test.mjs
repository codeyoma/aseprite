// Skill benchmarks (#82): the bench files, the blind judge prompt, run folder
// names, score parsing and generation.yaml, without Aseprite or a model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AXES, BENCH_DIR, JUDGE_IMAGES, MAX_EXTRA_IMAGES, benchNames, judgeImages, evaluate, judgeCommand, judgeFor, judgePrompt, loadBench, parseCheck,
  parseScores, rubricAxes, runDirName, toYaml, validateBench, withJudge,
} from "../../tests/bench/bench.mjs";

const IDENTITY = /claude|codex|anthropic|openai|gpt|opus|sonnet|haiku|gemini/i;

test("at least 5 benchmarks, each valid and for a different skill (or the same skill with the image generator)", () => {
  const names = benchNames();
  assert.ok(names.length >= 5, `benchmarks: ${names.join(", ")}`);
  const skills = new Set();
  for (const n of names) {
    const b = loadBench(n); // throws with every problem
    assert.ok(b.criteria.some((c) => c.type === "check" || c.type === "check_fx"), `${n}: checks the result with check or check_fx`);
    skills.add(`${b.skill}${b.allowImageGenerator ? "+image-generator" : ""}`);
  }
  assert.equal(skills.size, names.length);
});

test("the validator rejects bad benchmarks", () => {
  const good = JSON.parse(readFileSync(join(BENCH_DIR, "animate.json"), "utf8"));
  assert.deepEqual(validateBench(good), []);
  const bad = (patch) => validateBench({ ...good, ...patch });
  assert.match(bad({ skill: "nope" }).join(), /skill/);
  assert.match(bad({ fixture: "Sprite(8, 8)" }).join(), /palette/);
  assert.match(bad({ steps: ["/skill:animate only one"] }).join(), /two or more/);
  assert.match(bad({ steps: ["walk please", "more"] }).join(), /must start with \/skill:animate/);
  assert.match(bad({ extra: 1 }).join(), /unknown key extra/);
  assert.match(bad({ showLayers: "(" }).join(), /showLayers/);
  assert.match(bad({ criteria: [{ id: "a", type: "frames", min: -1 }] }).join(), /non-negative/);
  assert.match(bad({ criteria: [{ id: "a", type: "size", width: 4 }] }).join(), /height: required/);
  assert.match(bad({ criteria: [{ id: "a", type: "tag", name: "(" }] }).join(), /regular expression/);
  assert.match(bad({ criteria: [{ id: "a", type: "warp" }] }).join(), /type: one of/);
  assert.match(bad({ criteria: [{ id: "a", type: "skill" }, { id: "a", type: "skill" }] }).join(), /duplicate/);
  assert.match(bad({ criteria: [{ id: "a", type: "palette", colors: ["#FFF"] }] }).join(), /hex/);
  assert.match(bad({ criteria: [{ id: "a", type: "frames", bogus: 1 }] }).join(), /unknown key bogus/);
});

test("bench prompts and the rubric name no provider", () => {
  for (const n of benchNames()) for (const s of loadBench(n).steps) assert.doesNotMatch(s, IDENTITY, `${n}: ${s}`);
  assert.doesNotMatch(rubricAxes(), IDENTITY);
});

test("the judge prompt is blind: request, neutral image names and the rubric only", () => {
  for (const n of benchNames()) {
    const b = loadBench(n);
    const p = judgePrompt({ steps: b.steps, animated: b.animated });
    assert.doesNotMatch(p, IDENTITY, n);
    assert.doesNotMatch(p, /\/skill:|generation\.yaml|runs\/|\d{4}-\d{2}-\d{2}/, n);
    for (const im of JUDGE_IMAGES) assert.ok(p.includes(im.as) && !p.includes(im.file), `${n}: ${im.as}`);
    assert.ok(p.includes(b.steps[1]), `${n}: every step is in the request`);
    assert.match(p, animated(b) ? /score motion/ : /motion as null/);
    for (const axis of AXES) assert.ok(p.includes(`### ${axis}`), `${n}: rubric axis ${axis}`);
  }
  // The command passes no provider name or run path to the judge either, only the images.
  const cmd = judgeCommand("codex", { dir: "/tmp/x", images: ["/tmp/x/image-1.png"] });
  assert.ok(cmd.args.includes("--image=/tmp/x/image-1.png") && cmd.args.includes("read-only"));
  assert.deepEqual(judgeCommand("claude", { dir: "/tmp/x", images: [] }).args.slice(0, 3), ["-p", "--tools", "Read"]);
});
const animated = (b) => b.animated;

test("extra judge images follow the main three, numbered on, capped", () => {
  const extras = Array.from({ length: 9 }, (_, i) => ({ file: `sprite-${i + 1}.png`, what: `another sprite "set ${i}"` }));
  const ims = judgeImages(extras);
  assert.equal(ims.length, JUDGE_IMAGES.length + MAX_EXTRA_IMAGES);
  assert.deepEqual(ims.slice(0, 3), JUDGE_IMAGES);
  assert.deepEqual(ims.map((im) => im.as), ims.map((_, i) => `image-${i + 1}.png`));
  const p = judgePrompt({ steps: ["/skill:recolor a", "b"], animated: false, images: ims });
  assert.ok(p.includes("image-4.png: another sprite") && !p.includes("sprite-1.png"));
  assert.doesNotMatch(p, /starting sprite was given/);
  const withStart = judgePrompt({ steps: ["/skill:recolor a", "b"], animated: false, images: judgeImages([{ file: "start.png", what: "the sprite before the request" }]) });
  assert.match(withStart, /image-4\.png: the sprite before the request/);
  assert.match(withStart, /not the starting sprite's own design/);
});

test("the judge is never the provider that drew", () => {
  assert.equal(judgeFor("claude"), "codex");
  assert.equal(judgeFor("codex"), "claude");
  assert.equal(judgeFor("claude", "codex"), "codex");
  assert.throws(() => judgeFor("claude", "claude"), /must not be the provider/);
  assert.throws(() => judgeFor("claude", "gemini"), /unknown judge/);
});

test("run folders are <date>-<provider>, numbered when taken", () => {
  assert.equal(runDirName("2026-11-11", "claude"), "2026-11-11-claude");
  const taken = new Set(["2026-11-11-codex", "2026-11-11-codex-2"]);
  assert.equal(runDirName("2026-11-11", "codex", (n) => taken.has(n)), "2026-11-11-codex-3");
  assert.throws(() => runDirName("11/11/2026", "claude"), /YYYY-MM-DD/);
  assert.throws(() => runDirName("2026-11-11", "other"), /unknown provider/);
});

test("scores parse from the judge's answer", () => {
  const ans = 'Looking at it...\n```json\n{"readability": 3, "form": 2, "palette": 3, "motion": 1, "fit": 4, "note": "Reads well."}\n```';
  assert.deepEqual(parseScores(ans, { animated: true }), { scores: { readability: 3, form: 2, palette: 3, motion: 1, fit: 4 }, overall: 2.6, note: "Reads well." });
  // A still: motion is null whatever the judge said, and the mean leaves it out.
  assert.deepEqual(parseScores('{"readability":4,"form":3,"palette":3,"motion":2,"fit":2}', { animated: false }).scores.motion, null);
  assert.equal(parseScores('{"readability":4,"form":3,"palette":3,"motion":null,"fit":2}', { animated: false }).overall, 3);
  assert.throws(() => parseScores('{"readability":5,"form":3,"palette":3,"fit":2}', { animated: false }), /readability/);
  assert.throws(() => parseScores('{"readability":2,"form":3,"palette":3,"fit":2}', { animated: true }), /motion/);
  assert.throws(() => parseScores("no idea", { animated: false }), /no JSON/);
});

test("criteria decide from the facts the runner reads", () => {
  const sprite = { width: 24, height: 32, frames: 4, tags: [{ name: "Walk", from: 1, to: 4 }], layers: ["Hero", "AI: shaded"], same: [false, false, true, false], colors: ["000000", "ffffff"] };
  const ev = (c, f = {}) => evaluate(c, { sprite, ...f }, { skill: "animate" }).pass;
  assert.ok(ev({ type: "frames", min: 4, max: 4 }));
  assert.ok(!ev({ type: "frames", min: 5 }));
  assert.ok(ev({ type: "size", width: 24, height: 32 }));
  assert.ok(ev({ type: "tag", name: "walk", minFrames: 4 }));
  assert.ok(!ev({ type: "tag", name: "idle" }));
  assert.ok(ev({ type: "distinct", tag: "walk", min: 2 }) && !ev({ type: "distinct", tag: "walk", min: 3 }));
  assert.ok(ev({ type: "layers", match: "^AI: " }));
  assert.ok(ev({ type: "palette", colors: ["000000", "ffffff", "ff0000"] }) && !ev({ type: "palette", colors: ["000000"] }));
  assert.ok(ev({ type: "check" }, { text: "Check: 0 errors, 2 warnings\n..." }));
  assert.ok(!ev({ type: "check", maxWarnings: 1 }, { text: "Check: 0 errors, 2 warnings" }));
  assert.ok(ev({ type: "check_fx" }, { text: "FX check: 0 errors, 1 warnings (1 layer: x)" }));
  assert.ok(!ev({ type: "check" }, { text: "Error: no sprite" }));
  assert.ok(ev({ type: "skill" }, { headers: ["Agent · Animate a character or object"] }));
  assert.ok(!ev({ type: "skill" }, { headers: ["Agent"] }));
  assert.ok(ev({ type: "skill" }, { headers: ["Claude · animate"] }), "the header may show the skill's name");
  const sprites = [{ title: "grass 47-tile set", width: 128, height: 96, frames: 1, nineSlice: false, tilemap: false }];
  assert.ok(ev({ type: "sprites", title: "47-tile", width: 128, height: 96 }, { sprites }));
  assert.ok(!ev({ type: "sprites", title: "preview" }, { sprites }));
  assert.ok(ev({ type: "lua" }, { lua: { ok: true } }) && !ev({ type: "lua" }, { lua: { ok: false } }));
  assert.deepEqual(parseCheck("Check: 3 errors, 0 warnings"), { errors: 3, warnings: 0 });
});

test("generation.yaml is written as YAML, and the judge block can be replaced", () => {
  const y = toYaml({ benchmark: "animate", provider: "claude", model: null, seconds: 12, passed: 2,
    criteria: [{ id: "walk-tag", pass: true, detail: "walk 1-6" }, { id: "x", pass: false, detail: ["a: b", "true"] }],
    steps: [{ prompt: "/skill:animate Make: a walk", tools: [] }], empty: {} });
  assert.equal(y, [
    "benchmark: animate", "provider: claude", "model: null", "seconds: 12", "passed: 2",
    "criteria:", "  - id: walk-tag", "    pass: true", "    detail: walk 1-6",
    "  - id: x", "    pass: false", "    detail:", '      - "a: b"', '      - "true"',
    "steps:", '  - prompt: "/skill:animate Make: a walk"', "    tools: []", "empty: {}",
  ].join("\n"));
  const once = withJudge(`${y}\n`, { provider: "codex", overall: 2 });
  const twice = withJudge(once, { provider: "codex", overall: 3 });
  assert.match(twice, /judge:\n {2}provider: codex\n {2}overall: 3\n$/);
  assert.equal(twice.match(/^judge:/gm).length, 1);
  assert.ok(twice.startsWith(y));
});

test("motion_check criterion: errors fail by default, warnings only with maxWarnings (#111)", async () => {
  const { evaluate } = await import("../../tests/bench/bench.mjs");
  const text = (e, w) => [`MOTION CHECK "walk": x`, ...Array(e).fill("error: [volume] grows"), ...Array(w).fill("warning: [spacing] pops"), "spacing (px a frame): figure 1 2"].join("\n");
  assert.equal(evaluate({ type: "motion_check" }, { text: text(0, 2) }).pass, true);
  assert.equal(evaluate({ type: "motion_check" }, { text: text(1, 0) }).pass, false);
  assert.equal(evaluate({ type: "motion_check", maxWarnings: 1 }, { text: text(0, 2) }).pass, false);
  assert.match(evaluate({ type: "motion_check" }, { text: text(1, 1) }).detail, /^1 errors, 1 warnings; error: \[volume\] grows/);
  assert.equal(evaluate({ type: "motion_check" }, { text: "No tag \"walk\"." }).pass, false);
});
