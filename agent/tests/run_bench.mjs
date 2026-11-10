#!/usr/bin/env node
// Skill benchmarks (#82): runs the fixed prompt sequences in agent/tests/bench/<name>.json
// through the chat panel of the running Aseprite, checks each benchmark's pass/fail
// criteria through the tools, saves the result, and has the other provider judge
// it blind on the rubric in agent/tests/bench/RUBRIC.md.
//
//   node agent/tests/run_bench.mjs [options] [names]
//     --provider claude|codex   the agent that draws (default claude)
//     --judge claude|codex      the judge (default: the other provider; never the one that drew)
//     --no-judge                skip judging
//     --model <id>              recorded as the drawing model (the panel does not report it)
//     --judge-model <id>        the judge's model (passed to its CLI)
//     --timeout <minutes>       per prompt (default 15)
//     --rejudge <run dir>       judge an existing run again (no Aseprite needed)
//     --list                    list the benchmarks
//
// Each run goes to agent/tests/bench/runs/<date>-<provider>[-n]/<name>/:
// generation.yaml (prompts, provider, tool steps, criteria, timings, judge scores),
// filmstrip.png, final.png, final-1x.png and result.aseprite (plus extra-<n>.aseprite
// for other sprites the benchmark opened). Exit code 1 when a criterion failed.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCH_DIR, JUDGE_IMAGES, benchNames, evaluate, isoDate, judgeCommand, judgeFor, judgePrompt, linesOf, list,
  loadBench, parseScores, runDirName, selectSprites, toYaml, withJudge,
} from "./bench/bench.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = join(BENCH_DIR, "runs");

const argv = process.argv.slice(2);
const opts = { provider: "claude", judge: undefined, noJudge: false, model: null, judgeModel: undefined, minutes: 15, rejudge: null };
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--provider") opts.provider = argv[++i];
  else if (a === "--judge") opts.judge = argv[++i];
  else if (a === "--no-judge") opts.noJudge = true;
  else if (a === "--model") opts.model = argv[++i];
  else if (a === "--judge-model") opts.judgeModel = argv[++i];
  else if (a === "--timeout") opts.minutes = Number(argv[++i]);
  else if (a === "--rejudge") opts.rejudge = argv[++i];
  else if (a === "--list") { for (const n of benchNames()) console.log(`${n}: ${loadBench(n).title}`); process.exit(0); }
  else if (a.startsWith("--")) { console.error(`Unknown option ${a}`); process.exit(2); }
  else names.push(a);
}

// ---------------------------------------------------------------------------
// Judging (a one-shot CLI call in an empty folder holding only neutrally named images)

function runJudge(judge, { dir, bench, model }) {
  const tmp = mkdtempSync(join(tmpdir(), "bench-judge-"));
  const t0 = Date.now();
  try {
    const images = JUDGE_IMAGES.filter((im) => existsSync(join(dir, im.file)));
    if (!images.length) throw new Error("no images to judge");
    for (const im of images) copyFileSync(join(dir, im.file), join(tmp, im.as));
    const prompt = judgePrompt({ steps: bench.steps, animated: bench.animated, images });
    const { cmd, args } = judgeCommand(judge, { dir: tmp, images: images.map((im) => join(tmp, im.as)), model });
    const r = spawnSync(cmd, args, { cwd: tmp, input: prompt, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 << 20 });
    if (r.error) throw r.error;
    const answerFile = join(tmp, "answer.txt");
    const answer = existsSync(answerFile) ? readFileSync(answerFile, "utf8") : r.stdout;
    if (r.status !== 0 && !answer.trim()) throw new Error(`${cmd} exited with ${r.status}: ${(r.stderr ?? "").slice(-400)}`);
    const parsed = parseScores(answer, { animated: bench.animated });
    return { provider: judge, model: model ?? null, blind: true, images: images.map((im) => im.file), seconds: Math.round((Date.now() - t0) / 1000), ...parsed };
  } catch (e) {
    return { provider: judge, model: model ?? null, blind: true, error: String(e.message ?? e).slice(0, 500) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const judgeLine = (j) => (!j ? "not judged" : j.error ? `judge error: ${j.error.split("\n")[0]}` : `judge ${j.provider}: ${j.overall} (${Object.entries(j.scores).map(([k, v]) => `${k} ${v ?? "-"}`).join(", ")})`);

if (opts.rejudge) {
  const runDir = resolve(opts.rejudge);
  const provider = /-(claude|codex)(-\d+)?$/.exec(basename(runDir))?.[1];
  if (!provider) throw new Error(`${runDir}: expected a run folder named <date>-<provider>`);
  const judge = judgeFor(provider, opts.judge);
  for (const name of readdirSync(runDir).filter((n) => existsSync(join(runDir, n, "generation.yaml")))) {
    if (names.length && !names.includes(name)) continue;
    const bench = loadBench(name);
    const file = join(runDir, name, "generation.yaml");
    const j = runJudge(judge, { dir: join(runDir, name), bench, model: opts.judgeModel });
    writeFileSync(file, withJudge(readFileSync(file, "utf8"), j));
    console.log(`### ${name}: ${judgeLine(j)}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Running

const benches = (names.length ? names : benchNames()).map((n) => loadBench(n));
const judge = opts.noJudge ? null : judgeFor(opts.provider, opts.judge);
const { live } = await import("./live.mjs");
const { imageOf, textOf } = await import("./mcp_client.mjs");
const { c, lua, chat } = await live({ provider: opts.provider });

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).stdout.trim() || null;
mkdirSync(RUNS, { recursive: true });
const runDir = join(RUNS, runDirName(isoDate(), opts.provider, (n) => existsSync(join(RUNS, n))));
console.log(`Run: ${runDir}`);

/** Runs Lua and turns a thrown error into { ok: false }. */
const safeLua = async (code) => {
  try { return await lua(code); } catch (e) { return { ok: false, detail: String(e.message ?? e).slice(0, 300) }; }
};
const activeIndex = () => lua(`for i, s in ipairs(app.sprites) do if s == app.sprite then return { i = i } end end return { i = 0 }`).then((r) => r?.i ?? 0);
const activate = (i) => lua(`app.sprite = app.sprites[${i}] return { ok = true }`);

/** Sprites opened since the benchmark started (index > n0). */
const spritesSince = async (n0) => list(await lua(`local o = {}
  for i = ${n0} + 1, #app.sprites do local s = app.sprites[i]
    local nine, tm = false, false
    for _, sl in ipairs(s.slices) do if sl.center then nine = true end end
    for _, l in ipairs(s.layers) do if l.isTilemap then tm = true end end
    o[#o + 1] = { index = i, title = app.fs.fileTitle(s.filename), width = s.width, height = s.height, frames = #s.frames, nineSlice = nine, tilemap = tm }
  end return o`));

/** Facts about the active sprite: size, frames, tags, layer names, repeated frames, opaque colors (first 512). */
const spriteFacts = () => lua(`local s = app.sprite
  local o = { width = s.width, height = s.height, frames = #s.frames, tags = {}, layers = {}, same = {}, colors = {} }
  for _, t in ipairs(s.tags) do o.tags[#o.tags + 1] = { name = t.name, from = t.fromFrame.frameNumber, to = t.toFrame.frameNumber } end
  local function walk(list) for _, l in ipairs(list) do o.layers[#o.layers + 1] = l.name if l.isGroup then walk(l.layers) end end end
  walk(s.layers)
  local prev, seen = nil, {}
  for f = 1, #s.frames do
    local img = Image(s.width, s.height, ColorMode.RGB) img:drawSprite(s, f)
    o.same[f] = (prev ~= nil) and img:isEqual(prev)
    for it in img:pixels() do local v = it()
      if app.pixelColor.rgbaA(v) >= 128 and #o.colors < 512 then
        local k = string.format("%02x%02x%02x", app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
        if not seen[k] then seen[k] = true o.colors[#o.colors + 1] = k end
      end
    end
    prev = img
  end
  return o`);

const entries = async () => list(await lua("return AsepriteAgent.entries()"));
const savePng = (r, file) => {
  const png = r && !r.isError ? imageOf(r) : null;
  if (png) writeFileSync(file, png);
  return png ? basename(file) : null;
};

let failedAny = false;
for (const bench of benches) {
  const dir = join(runDir, bench.name);
  mkdirSync(dir, { recursive: true });
  const started = new Date();
  // Each benchmark starts from a new chat with no sprites open, so nothing carries over.
  await lua(`AsepriteAgent.newChat() for i = #app.sprites, 1, -1 do app.sprites[i]:close() end return true`);
  const n0 = (await lua("return { n = #app.sprites }")).n;
  let seen = (await entries()).length;
  await lua(`${linesOf(bench.fixture)}\nreturn { ok = true }`);

  const steps = [];
  const headers = [];
  for (const prompt of bench.steps) {
    let seconds = null, error = null;
    try { seconds = await chat(prompt, { timeout: opts.minutes * 60_000 }); } catch (e) { error = String(e.message ?? e); }
    const all = await entries();
    const fresh = all.slice(seen);
    seen = all.length;
    const header = fresh.find((e) => e.kind === "header")?.text ?? null;
    if (header) headers.push(header);
    steps.push({
      prompt, seconds, ...(error ? { error } : {}), header,
      tools: fresh.filter((e) => e.kind === "tool").map((e) => ({ tool: e.text ?? "", status: e.status ?? "ok" })),
      reply: fresh.filter((e) => e.kind === "text").map((e) => e.text).join("\n").slice(0, 800),
      errors: fresh.filter((e) => e.kind === "error").map((e) => String(e.text).slice(0, 300)),
    });
    console.log(`  ${bench.name} step ${steps.length}: ${error ?? `${seconds}s`}, ${steps.at(-1).tools.length} tool calls`);
  }

  // The sprite the files and the judge show: the benchmark's target, else the active one.
  const sprites = await spritesSince(n0);
  const target = bench.target ? selectSprites(sprites, bench.target)[0] : null;
  if (target) await activate(target.index);
  const home = await activeIndex();

  const criteria = [];
  const factsCache = new Map();
  for (const crit of bench.criteria) {
    let result;
    if (crit.sprite) {
      const s = selectSprites(sprites, crit.sprite)[0];
      if (!s) { criteria.push({ id: crit.id, type: crit.type, desc: crit.desc ?? null, pass: false, detail: `no sprite matches ${JSON.stringify(crit.sprite)}` }); continue; }
      await activate(s.index);
    }
    const idx = await activeIndex();
    const facts = { headers, sprites };
    if (["frames", "size", "tag", "distinct", "layers", "palette"].includes(crit.type)) {
      if (!factsCache.has(idx)) factsCache.set(idx, await spriteFacts());
      facts.sprite = factsCache.get(idx);
    } else if (crit.type === "check") facts.text = textOf(await c.call("check", crit.rules ? { rules: crit.rules } : {}));
    else if (crit.type === "check_fx") facts.text = textOf(await c.call("check_fx", {}));
    else if (crit.type === "lua") facts.lua = await safeLua(linesOf(crit.code));
    result = evaluate(crit, facts, { skill: bench.skill });
    criteria.push({ id: crit.id, type: crit.type, desc: crit.desc ?? null, pass: result.pass, detail: result.detail ?? null });
    if (crit.sprite) await activate(home);
  }

  // Files: the review images and the .aseprite of each sprite the benchmark made.
  const files = [];
  const frames = (await spriteFacts()).frames;
  files.push(savePng(await c.call("snapshot", { view: "filmstrip" }), join(dir, "filmstrip.png")));
  files.push(savePng(await c.call("snapshot", { frame: frames }), join(dir, "final.png")));
  files.push(savePng(await c.call("snapshot", { frame: frames, scale: 1 }), join(dir, "final-1x.png")));
  let extra = 0;
  for (const s of [{ index: home }, ...sprites.filter((s) => s.index !== home)]) {
    const name = s.index === home ? "result.aseprite" : `extra-${++extra}.aseprite`;
    const r = await safeLua(`app.sprites[${s.index}]:saveCopyAs(${JSON.stringify(join(dir, name))}) return { ok = true }`);
    if (r?.ok) files.push(name);
  }
  await activate(home);

  const passed = criteria.filter((x) => x.pass).length;
  if (passed < criteria.length) failedAny = true;
  const record = {
    benchmark: bench.name,
    skill: bench.skill,
    title: bench.title,
    provider: opts.provider,
    model: opts.model,
    commit,
    date: started.toISOString(),
    seconds: steps.reduce((a, s) => a + (s.seconds ?? 0), 0),
    passed,
    total: criteria.length,
    criteria,
    steps,
    files: files.filter(Boolean),
  };
  let yaml = `${toYaml(record)}\n`;
  if (judge) {
    const j = runJudge(judge, { dir, bench, model: opts.judgeModel });
    yaml = withJudge(yaml, j);
    record.judge = j;
  }
  writeFileSync(join(dir, "generation.yaml"), yaml);
  console.log(`### ${bench.name}: ${passed}/${criteria.length} criteria in ${record.seconds}s; ${judgeLine(record.judge)}`);
  for (const x of criteria) if (!x.pass) console.log(`  FAIL ${x.id} ${JSON.stringify(x.detail)}`.slice(0, 300));
}
c.stop();
console.log(failedAny ? "BENCH: some criteria failed" : "BENCH: all criteria passed");
process.exit(failedAny ? 1 : 0);
