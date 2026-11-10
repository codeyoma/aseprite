// Pixel-art rules (#77): chapters list and read through read_guide, list_skills
// and the MCP resources rules://<chapter>; every cited rule id exists; grid
// templates parse as write_pixels grids; rules never ride along with triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { citedRules, gridTemplates, readRule, ruleChapters, ruleIds } from "../dist/rules.js";
import { allSkills, skillContext } from "../dist/guide.js";
import { parseGrid, parseLegend } from "../dist/pixel_text.js";
import { findTool, runTool } from "../dist/tools.js";
import { startHttpEndpoint } from "../dist/http.js";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHAPTERS = ["animation", "characters", "isometric", "tiles", "ui", "vfx"];
const ctx = { request: async () => ({}) };
const textOf = (r) => r.content.map((c) => c.text ?? "").join("\n");

function mdFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

test("the six chapters load with unique, prefixed rule ids", () => {
  const chapters = ruleChapters();
  assert.deepEqual(chapters.map((c) => c.name), CHAPTERS);
  const seen = new Set();
  for (const c of chapters) {
    assert.ok(c.description.length > 20, `${c.name} has a description`);
    for (const id of [c.id, ...c.rules.map((r) => r.id)]) {
      assert.ok(id === c.id || id.startsWith(`${c.id}.`), `${id} starts with ${c.id}.`);
      assert.ok(!seen.has(id), `${id} is unique`);
      seen.add(id);
    }
    for (const part of ["mistakes", "review", "templates"]) assert.ok(seen.has(`${c.id}.${part}`), `${c.name} has ${part}`);
  }
});

test("read_guide lists and reads rules: index, chapter, single rule", async () => {
  const read = (topic) => runTool(findTool("read_guide"), topic === undefined ? {} : { topic }, ctx);
  assert.match(textOf(await read()), /Rules \(read_guide\("rules"\) lists rule ids\): rules\/animation, /);
  const index = textOf(await read("rules"));
  for (const c of CHAPTERS) assert.match(index, new RegExp(`- rules/${c} `));
  assert.match(index, /anim\.timing\.walk/);
  const chapter = textOf(await read("rules/animation"));
  assert.match(chapter, /^# Animation timing \{#anim\}/);
  assert.match(chapter, /## Timing table \{#anim\.timing\}/);
  const walk = textOf(await read("anim.timing.walk"));
  assert.match(walk, /^### Walk \{#anim\.timing\.walk\}/);
  assert.ok(!/### Run/.test(walk), "a rule stops at the next heading of its level");
  assert.equal(textOf(await read("rule:anim.timing.walk")), walk);
  // A section that holds a grid keeps the whole fenced block.
  assert.match(readRule("ui.tmpl.digits"), /```grid[\s\S]*```/);
  assert.equal((await read("rules/nope")).isError, true);
  assert.equal((await read("anim.nope")).isError, true);
});

test("list_skills ends with the rule chapters and filters them by query", async () => {
  const all = textOf(await runTool(findTool("list_skills"), {}, ctx));
  assert.match(all, /Rules \(read_guide\("rules\/<chapter>"\), resource rules:\/\/<chapter>\):/);
  for (const c of CHAPTERS) assert.match(all, new RegExp(`- rules/${c}: `));
  const iso = textOf(await runTool(findTool("list_skills"), { query: "isometric" }, ctx));
  assert.match(iso, /- rules\/isometric: /);
  assert.ok(!/- rules\/ui: /.test(iso));
});

test("rules are not skills: no trigger brings them into a prompt", () => {
  const names = [...allSkills().keys()];
  assert.ok(!names.some((n) => n.startsWith("rules") || CHAPTERS.includes(n)), names.join());
  for (const msg of ["make a walk cycle", "isometric tiles", "hit spark vfx", "health bar ui"]) {
    const { context } = skillContext(msg);
    assert.ok(!/\{#(anim|char|tile|iso|vfx|ui)[.}]/.test(context), `"${msg}" inlined a rule chapter`);
  }
  // Forcing the animate skill brings its text, which points at the chapter but does not contain it.
  const forced = skillContext("/skill:animate walk");
  assert.match(forced.context, /read_guide\("rules\/animation"\)/);
  assert.ok(!/## Timing table/.test(forced.context));
});

test("every rule id cited in skills and guide topics exists", () => {
  const ids = ruleIds();
  const files = [
    ...readdirSync(join(AGENT, "skills")).map((n) => join(AGENT, "skills", n, "SKILL.md")).filter(existsSync),
    ...mdFiles(join(AGENT, "guide")),
  ];
  const missing = [];
  let cited = 0;
  for (const f of files) {
    for (const id of citedRules(readFileSync(f, "utf8"))) {
      cited++;
      if (!ids.has(id)) missing.push(`${relative(AGENT, f)}: rule:${id}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(cited >= 20, `skills and guide cite rules (${cited})`);
  for (const skill of ["animate", "make-tileset", "make-ui", "pixel-fx", "make-directions"]) {
    assert.ok(citedRules(readFileSync(join(AGENT, "skills", skill, "SKILL.md"), "utf8")).length, `${skill} cites rules`);
  }
});

test("grid templates parse as write_pixels grids, every key in its legend", () => {
  let n = 0;
  for (const c of ruleChapters()) {
    const templates = gridTemplates(c);
    assert.ok(templates.length, `${c.name} has templates`);
    for (const t of templates) {
      n++;
      assert.match(t.legend, /^Legend: /, `${t.id}: the block starts with a Legend: line`);
      assert.ok(t.id.startsWith(`${c.id}.tmpl.`), `${t.id} sits under a template heading`);
      const legend = parseLegend(t.legend);
      const grid = parseGrid(t.rows, t.legend); // throws on ragged rows and unknown keys
      assert.ok(grid.width > 1 && grid.height > 1, t.id);
      const used = new Set(grid.rows.flatMap((r) => r.split(" ")));
      for (const k of used) assert.ok(k === "." || Object.hasOwn(legend, k), `${t.id}: key '${k}' is in the legend`);
    }
  }
  assert.ok(n >= 12, `${n} templates`);
});

test("MCP resources rules://<chapter> are listed and readable", async () => {
  const ep = await startHttpEndpoint({ request: async () => ({ result: {} }) }, "t0k");
  try {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ep.url), { requestInit: { headers: { Authorization: "Bearer t0k" } } }));
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri).filter((u) => u.startsWith("rules://")).sort(), CHAPTERS.map((c) => `rules://${c}`));
    const r = await client.readResource({ uri: "rules://tiles" });
    assert.match(r.contents[0].text, /^# Tiles \{#tile\}/);
    assert.equal(r.contents[0].mimeType, "text/markdown");
    await client.close();
  } finally {
    ep.server.close();
  }
});
