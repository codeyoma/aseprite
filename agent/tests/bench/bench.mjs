// Skill benchmarks (#82): the pure half of run_bench.mjs, with no Aseprite and
// no model, so `npm test` can check it. A benchmark is agent/tests/bench/<name>.json:
// a fixture (Lua that builds the starting sprite with its own palette), a fixed
// sequence of prompts, and pass/fail criteria the runner checks through the tools.
// A run is judged blind on the 5-axis rubric in RUBRIC.md by the other provider.
// Idea and rubric shape from aseprite-ai-artist (MIT): gallery/RUBRIC.md, docs/evals/benchmarks.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(BENCH_DIR, "..", "..", "skills");

export const PROVIDERS = ["claude", "codex"];
/** Rubric axes, in RUBRIC.md order; `motion` is scored only for animated benchmarks. */
export const AXES = ["readability", "form", "palette", "motion", "fit"];

// ---------------------------------------------------------------------------
// Benchmark files

/** Criterion types: the params each takes (name: "required" | "optional"). */
export const CRITERIA = {
  skill: {},
  frames: { min: "optional", max: "optional" },
  size: { width: "required", height: "required" },
  tag: { name: "required", minFrames: "optional" },
  distinct: { min: "required", tag: "optional" },
  layers: { match: "required", min: "optional" },
  check: { rules: "optional", maxErrors: "optional", maxWarnings: "optional" },
  check_fx: { maxErrors: "optional" },
  palette: { colors: "required" },
  sprites: { title: "optional", minFrames: "optional", width: "optional", height: "optional", nineSlice: "optional", tilemap: "optional", min: "optional" },
  lua: { code: "required" },
};
const COMMON = ["id", "type", "desc", "sprite"];
const BENCH_KEYS = ["skill", "title", "fixture", "steps", "target", "showLayers", "animated", "criteria"];
const SELECTOR_KEYS = ["title", "minFrames"];

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isRegex = (v) => {
  try { new RegExp(v); return typeof v === "string"; } catch { return false; }
};
const isLines = (v) => typeof v === "string" ? v.trim() !== "" : Array.isArray(v) && v.length > 0 && v.every((l) => typeof l === "string");
export const linesOf = (v) => (Array.isArray(v) ? v.join("\n") : v);

function checkSelector(sel, where, errors) {
  if (typeof sel !== "object" || sel === null || Array.isArray(sel)) return errors.push(`${where}: an object { title?, minFrames? }`);
  for (const k of Object.keys(sel)) if (!SELECTOR_KEYS.includes(k)) errors.push(`${where}: unknown key ${k}`);
  if (sel.title !== undefined && !isRegex(sel.title)) errors.push(`${where}.title: a regular expression`);
  if (sel.minFrames !== undefined && !isInt(sel.minFrames)) errors.push(`${where}.minFrames: an integer`);
}

/** Problems with a benchmark object (an empty list when it is valid). `skills` lists the built-in skill names. */
export function validateBench(b, { skills = builtInSkills() } = {}) {
  const errors = [];
  if (typeof b !== "object" || b === null || Array.isArray(b)) return ["a benchmark is a JSON object"];
  for (const k of Object.keys(b)) if (!BENCH_KEYS.includes(k)) errors.push(`unknown key ${k}`);
  if (typeof b.skill !== "string" || !skills.includes(b.skill)) errors.push(`skill: a built-in skill name (got ${JSON.stringify(b.skill)})`);
  if (typeof b.title !== "string" || !b.title.trim()) errors.push("title: a short description");
  if (!isLines(b.fixture)) errors.push("fixture: Lua code (a string or an array of lines)");
  else if (!/setPalette/.test(linesOf(b.fixture))) errors.push("fixture: must set an explicit palette (setPalette), so checks do not depend on the user's default palette");
  if (!Array.isArray(b.steps) || b.steps.length < 2 || !b.steps.every((s) => typeof s === "string" && s.trim())) errors.push("steps: two or more prompts");
  else if (!b.steps[0].startsWith(`/skill:${b.skill} `)) errors.push(`steps[0]: must start with /skill:${b.skill}`);
  if (typeof b.animated !== "boolean") errors.push("animated: true when the motion axis is scored");
  if (b.target !== undefined) checkSelector(b.target, "target", errors);
  if (b.showLayers !== undefined && !isRegex(b.showLayers)) errors.push("showLayers: a regular expression for layers the judge also sees alone");
  if (!Array.isArray(b.criteria) || !b.criteria.length) errors.push("criteria: a non-empty list");
  else {
    const ids = new Set();
    b.criteria.forEach((c, i) => {
      const where = `criteria[${i}]`;
      if (typeof c !== "object" || c === null) return errors.push(`${where}: an object`);
      if (typeof c.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errors.push(`${where}.id: kebab-case`);
      else if (ids.has(c.id)) errors.push(`${where}.id: duplicate ${c.id}`);
      else ids.add(c.id);
      const spec = CRITERIA[c.type];
      if (!spec) return errors.push(`${where}.type: one of ${Object.keys(CRITERIA).join(", ")}`);
      for (const k of Object.keys(c)) if (!COMMON.includes(k) && !(k in spec)) errors.push(`${where}: unknown key ${k} for ${c.type}`);
      for (const [k, need] of Object.entries(spec)) if (need === "required" && c[k] === undefined) errors.push(`${where}.${k}: required for ${c.type}`);
      if (c.sprite !== undefined) checkSelector(c.sprite, `${where}.sprite`, errors);
      for (const k of ["min", "max", "width", "height", "minFrames", "maxErrors", "maxWarnings"]) {
        if (c[k] !== undefined && !isInt(c[k])) errors.push(`${where}.${k}: a non-negative integer`);
      }
      for (const k of ["name", "match", "tag", "title"]) if (c[k] !== undefined && !isRegex(c[k])) errors.push(`${where}.${k}: a regular expression`);
      if (c.type === "palette" && !(Array.isArray(c.colors) && c.colors.length && c.colors.every((h) => /^[0-9a-f]{6}$/.test(h)))) errors.push(`${where}.colors: lowercase rrggbb hex strings`);
      if (c.type === "check" && c.rules !== undefined && !(Array.isArray(c.rules) && c.rules.every((r) => typeof r === "string"))) errors.push(`${where}.rules: a list of rule names`);
      if (c.type === "lua" && !isLines(c.code)) errors.push(`${where}.code: Lua that returns { ok = boolean, detail = ... }`);
      for (const k of ["nineSlice", "tilemap"]) if (c[k] !== undefined && typeof c[k] !== "boolean") errors.push(`${where}.${k}: a boolean`);
    });
  }
  return errors;
}

export function builtInSkills() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md"))).map((e) => e.name);
}

/** Names of the benchmark files (agent/tests/bench/<name>.json). */
export const benchNames = (dir = BENCH_DIR) => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

/** Reads and validates one benchmark; throws with every problem listed. */
export function loadBench(name, dir = BENCH_DIR) {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`No benchmark ${name} (${benchNames(dir).join(", ")})`);
  const b = JSON.parse(readFileSync(file, "utf8"));
  const errors = validateBench(b);
  if (errors.length) throw new Error(`${name}.json:\n  ${errors.join("\n  ")}`);
  return { name, ...b };
}

// ---------------------------------------------------------------------------
// Criteria: the runner gathers facts through the tools, these decide pass/fail.

/** The skill's title (the turn header ends with it). */
export function skillTitle(name) {
  return /^title:\s*(.+?)\s*$/m.exec(readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8"))?.[1] ?? name;
}

/** Errors and warnings from `check` or `check_fx` text ("Check: 0 errors, 1 warnings"). */
export function parseCheck(text) {
  const m = /(\d+) errors?, (\d+) warnings?/.exec(text ?? "");
  return m ? { errors: +m[1], warnings: +m[2] } : null;
}

/** An empty Lua table comes back as {}. */
export const list = (x) => (Array.isArray(x) ? x : []);

/** Sprites (from the runner's sprite list) matching a selector { title, minFrames }. */
export const selectSprites = (sprites, sel = {}) =>
  list(sprites).filter((s) => (sel.title === undefined || new RegExp(sel.title, "i").test(s.title ?? "")) && (sel.minFrames === undefined || s.frames >= sel.minFrames));

/**
 * Decides one criterion. `facts` holds what the runner read for it:
 *   sprite  { width, height, frames, tags: [{ name, from, to }], layers: [names], same: [bool per frame], colors: [hex] }
 *   sprites [{ title, width, height, frames, nineSlice, tilemap }] (opened during the benchmark)
 *   headers [header texts of this benchmark's turns], text (check / check_fx output), lua ({ ok, detail })
 * Returns { pass, detail }.
 */
export function evaluate(c, facts, { skill } = {}) {
  const s = facts.sprite ?? {};
  switch (c.type) {
    case "skill": {
      const title = skillTitle(skill);
      const h = list(facts.headers);
      // The header ends with the skill's title, or its name when the panel shows that ("Claude · animate").
      return { pass: h.some((t) => t === skill || t?.endsWith(title) || t?.endsWith(` ${skill}`)), detail: h.slice(0, 3) };
    }
    case "frames":
      return { pass: s.frames >= (c.min ?? 0) && s.frames <= (c.max ?? Infinity), detail: s.frames };
    case "size":
      return { pass: s.width === c.width && s.height === c.height, detail: `${s.width}x${s.height}` };
    case "tag": {
      const t = list(s.tags).find((t) => new RegExp(c.name, "i").test(t.name));
      const n = t ? t.to - t.from + 1 : 0;
      return { pass: !!t && n >= (c.minFrames ?? 1), detail: t ? `${t.name} ${t.from}-${t.to}` : list(s.tags).map((t) => t.name) };
    }
    case "distinct": {
      // Frames that differ from the one before, inside the tag (or the whole sprite).
      const t = c.tag ? list(s.tags).find((t) => new RegExp(c.tag, "i").test(t.name)) : { from: 1, to: s.frames };
      if (!t) return { pass: false, detail: `no tag ${c.tag}` };
      const same = list(s.same);
      let n = 0;
      for (let f = t.from + 1; f <= t.to; f++) if (same[f - 1] === false) n++;
      return { pass: n >= c.min, detail: n };
    }
    case "layers": {
      const hits = list(s.layers).filter((l) => new RegExp(c.match).test(l));
      return { pass: hits.length >= (c.min ?? 1), detail: hits.length ? hits : list(s.layers) };
    }
    case "check":
    case "check_fx": {
      const r = parseCheck(facts.text);
      if (!r) return { pass: false, detail: (facts.text ?? "").split("\n")[0] };
      return { pass: r.errors <= (c.maxErrors ?? 0) && (c.maxWarnings === undefined || r.warnings <= c.maxWarnings), detail: `${r.errors} errors, ${r.warnings} warnings` };
    }
    case "palette": {
      const off = list(s.colors).filter((h) => !c.colors.includes(h));
      return { pass: off.length === 0 && list(s.colors).length > 0, detail: off.length ? off.slice(0, 12) : `${list(s.colors).length} colors` };
    }
    case "sprites": {
      const hits = selectSprites(facts.sprites, c).filter((x) =>
        (c.width === undefined || x.width === c.width) && (c.height === undefined || x.height === c.height) &&
        (c.nineSlice === undefined || x.nineSlice === c.nineSlice) && (c.tilemap === undefined || x.tilemap === c.tilemap));
      return { pass: hits.length >= (c.min ?? 1), detail: list(facts.sprites).map((x) => `${x.title} ${x.width}x${x.height} ${x.frames}f`) };
    }
    case "lua":
      return { pass: facts.lua?.ok === true, detail: facts.lua?.detail ?? facts.lua ?? null };
    default:
      return { pass: false, detail: `unknown criterion type ${c.type}` };
  }
}

// ---------------------------------------------------------------------------
// Runs

/** Local date as YYYY-MM-DD. */
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A run's folder name: <date>-<provider>, with -2, -3... when one exists already. */
export function runDirName(date, provider, exists = () => false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`date must be YYYY-MM-DD: ${date}`);
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider ${provider}`);
  const base = `${date}-${provider}`;
  if (!exists(base)) return base;
  for (let n = 2; ; n++) if (!exists(`${base}-${n}`)) return `${base}-${n}`;
}

/** The judge provider: the one asked for, else the other one; never the one that drew. */
export function judgeFor(provider, judge) {
  const j = judge ?? PROVIDERS.find((p) => p !== provider);
  if (!PROVIDERS.includes(j)) throw new Error(`unknown judge ${j}`);
  if (j === provider) throw new Error(`the judge must not be the provider that drew the art (${provider})`);
  return j;
}

// ---------------------------------------------------------------------------
// Judging

/** The request as the judge sees it: the steps with the /skill: prefix removed. */
export const requestText = (steps) => steps.map((s, i) => `${i + 1}. ${s.replace(/^\/skill:\S+\s+/, "")}`).join("\n");

/** The "## Axes" section of RUBRIC.md, which the judge scores against. */
export function rubricAxes(file = join(BENCH_DIR, "RUBRIC.md")) {
  const md = readFileSync(file, "utf8");
  const start = md.indexOf("\n## Axes\n");
  if (start < 0) throw new Error("RUBRIC.md has no ## Axes section");
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start + 1, end < 0 ? undefined : end).trim();
}

/** Images shown to the judge, in order, under neutral names. */
export const JUDGE_IMAGES = [
  { file: "filmstrip.png", as: "image-1.png", what: "every frame of the result side by side, numbered, enlarged" },
  { file: "final.png", as: "image-2.png", what: "the last frame, enlarged so single pixels are visible" },
  { file: "final-1x.png", as: "image-3.png", what: "the last frame at its real size (1x)" },
];

/** Most extra images (other sprites, layers alone) a judge gets, so the prompt stays small. */
export const MAX_EXTRA_IMAGES = 6;

/**
 * The judge's image list: the three main images, then extras ({ file, what }) for
 * what the main sprite's last frame cannot show (other sprites the request made,
 * variant layers hidden under the top one), numbered on from image-4.png.
 */
export function judgeImages(extras = []) {
  const more = extras.slice(0, MAX_EXTRA_IMAGES).map((x, i) => ({ file: x.file, as: `image-${JUDGE_IMAGES.length + i + 1}.png`, what: x.what }));
  return [...JUDGE_IMAGES, ...more];
}

/** The file the runner writes with the judge's image list, so --rejudge shows the same images. */
export const IMAGES_FILE = "judge-images.json";

/**
 * The judge prompt. It names no provider, model or run: only the request, the
 * images (by neutral file names) and the rubric.
 */
export function judgePrompt({ steps, animated, images = JUDGE_IMAGES, rubric = rubricAxes() }) {
  return [
    "You are judging pixel art made in Aseprite for a fixed request. You are not told who or what made it; judge only the images.",
    "",
    "The request, given in this order:",
    requestText(steps),
    "",
    "Images (files in the current directory):",
    ...images.map((im) => `- ${im.as}: ${im.what}`),
    "",
    "Score each axis from 0 to 4 against the anchors below. When the work sits between two anchors, give the lower score unless every part of the higher one holds.",
    animated ? "This is an animation: score motion." : "This is a still image: give motion as null.",
    ...(images.some((im) => im.file === "start.png")
      ? ["The starting sprite was given with the request (the image described as the sprite before the request). Score what was made on it and how well it fits the request, not the starting sprite's own design."]
      : []),
    "",
    rubric,
    "",
    "Answer with one JSON object and nothing else:",
    `{"readability": 0-4, "form": 0-4, "palette": 0-4, "motion": ${animated ? "0-4" : "null"}, "fit": 0-4, "note": "one or two sentences on the biggest strength and weakness"}`,
  ].join("\n");
}

/**
 * Scores from the judge's answer: the last JSON object in it (fenced or not).
 * Returns { scores, overall, note }; throws when an axis is missing or out of range.
 */
export function parseScores(text, { animated }) {
  const candidates = [...String(text).matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).reverse();
  let raw;
  for (const c of candidates) {
    try { raw = JSON.parse(c); break; } catch { /* try the next one */ }
  }
  if (!raw) throw new Error(`no JSON scores in the judge's answer: ${String(text).slice(0, 200)}`);
  const scores = {};
  for (const axis of AXES) {
    const v = raw[axis];
    if (axis === "motion" && !animated) { scores.motion = null; continue; }
    if (!Number.isInteger(v) || v < 0 || v > 4) throw new Error(`${axis}: expected an integer 0-4, got ${JSON.stringify(v)}`);
    scores[axis] = v;
  }
  const vals = Object.values(scores).filter((v) => v !== null);
  const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  return { scores, overall, note: typeof raw.note === "string" ? raw.note : "" };
}

/** Command line for a one-shot judge call; the prompt goes on stdin (both CLIs read it there). */
export function judgeCommand(judge, { dir, images, model }) {
  if (judge === "claude") {
    return { cmd: "claude", args: ["-p", "--tools", "Read", "--allowedTools", "Read", "--strict-mcp-config", "--no-session-persistence", "--output-format", "text", ...(model ? ["--model", model] : [])] };
  }
  if (judge === "codex") {
    return { cmd: "codex", args: ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", dir, ...images.map((f) => `--image=${f}`), "-o", join(dir, "answer.txt"), ...(model ? ["-m", model] : [])] };
  }
  throw new Error(`unknown judge ${judge}`);
}

// ---------------------------------------------------------------------------
// generation.yaml: a small YAML writer (no YAML package in the bridge).

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  const s = String(v);
  // Plain when it cannot be read as anything else; otherwise a JSON string, which is valid YAML.
  if (/^[A-Za-z_][\w .\/()+-]*$/.test(s) && !/\s$/.test(s) && !RESERVED.test(s)) return s;
  return JSON.stringify(s);
}
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** YAML for plain data (objects, arrays, strings, numbers, booleans, null). */
export function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value.map((v) => {
      if (isPlainObject(v) && Object.keys(v).length) {
        const body = toYaml(v, indent + 2).split("\n");
        return `${pad}- ${body[0].trimStart()}${body.length > 1 ? "\n" + body.slice(1).join("\n") : ""}`;
      }
      if (Array.isArray(v) && v.length) return `${pad}-\n${toYaml(v, indent + 2)}`;
      return `${pad}- ${isPlainObject(v) ? "{}" : Array.isArray(v) ? "[]" : scalar(v)}`;
    }).join("\n");
  }
  if (isPlainObject(value)) {
    if (!Object.keys(value).length) return "{}";
    return Object.entries(value).map(([k, v]) => {
      const key = scalar(k);
      if ((isPlainObject(v) && Object.keys(v).length) || (Array.isArray(v) && v.length)) return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      return `${pad}${key}: ${isPlainObject(v) ? "{}" : Array.isArray(v) ? "[]" : scalar(v)}`;
    }).join("\n");
  }
  return pad + scalar(value);
}

/** Replaces (or appends) the top-level `judge:` block of a generation.yaml. */
export function withJudge(yaml, judge) {
  const lines = yaml.replace(/\n+$/, "").split("\n");
  const i = lines.findIndex((l) => /^judge:/.test(l));
  let kept = lines;
  if (i >= 0) {
    let j = i + 1;
    while (j < lines.length && /^(\s|$)/.test(lines[j])) j++;
    kept = [...lines.slice(0, i), ...lines.slice(j)];
  }
  return `${kept.join("\n")}\n${toYaml({ judge })}\n`;
}
