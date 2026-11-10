// studio: an orchestrator with no pixel tools of its own, so the eval checks its routing table against the real
// catalog. The steps read every skill and guide topic the table routes to (as the agent does when it reaches a
// stage); the check holds the table to the catalog: every name exists (`concept` only when marked "if installed"),
// every built-in skill is reachable, and the SKILL.md asks for a brief, a plan, read_guide per stage and a
// compromise report.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSkill } from "../../bridge/dist/guide.js";
import { fakeDocument } from "./_helpers.mjs";

const AGENT = new URL("../../", import.meta.url);
const md = readFileSync(fileURLToPath(new URL("skills/studio/SKILL.md", AGENT)), "utf8");
const skill = parseSkill(md, "studio", "built-in");

/** Built-in skills and guide topics as shipped (user skills left out). */
const builtIn = readdirSync(fileURLToPath(new URL("skills/", AGENT))).filter((n) => existsSync(fileURLToPath(new URL(`skills/${n}/SKILL.md`, AGENT))));
const topics = readdirSync(fileURLToPath(new URL("guide/", AGENT))).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const known = new Set([...builtIn, ...topics]);

/** Routing rows: { want, chain, names } from the table under "## Routing". */
const section = skill.body.slice(skill.body.indexOf("## Routing"));
const rows = section.split("\n").filter((l) => /^\| /.test(l) && !/^\|\s*-/.test(l)).slice(1)
  .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
  .map(([want, chain]) => ({ want, chain, names: [...chain.matchAll(/`([^`]+)`/g)].map((m) => m[1]) }));
const routed = [...new Set(rows.flatMap((r) => r.names))];
const optional = (name) => rows.every((r) => !r.names.includes(name) || new RegExp("`" + name + "` \\(if installed\\)").test(r.chain));
const readable = routed.filter((n) => known.has(n));

export default {
  skill: "studio",
  skipLive: "a text skill: nothing to build or read in Aseprite (live: tests/studio_live.mjs)",
  fixture: () => fakeDocument({ width: 32, height: 32, palette: ["#000000", "#ffffff"], layers: [{ name: "Layer 1" }] }),
  steps: readable.map((topic) => ({ tool: "read_guide", input: { topic } })),
  check: (fake, results, assert) => {
    assert.ok(rows.length >= 10, `routing rows (${rows.length})`);
    for (const r of rows) assert.ok(r.names.length, `row "${r.want}" names a skill`);
    // Every routed name is a real skill or guide topic; a skill that may be missing says so.
    const unknown = routed.filter((n) => !known.has(n) && !optional(n));
    assert.deepEqual(unknown, [], "routing names that are neither skills nor guide topics (mark optional ones \"(if installed)\")");
    // Every built-in skill except studio is reachable from the table.
    const unreachable = builtIn.filter((n) => n !== "studio" && !routed.includes(n));
    assert.deepEqual(unreachable, [], "built-in skills missing from studio's routing table");
    // read_guide returned each routed skill's text.
    results.forEach((r, i) => assert.ok(r.content[0].text.length > 100, `read_guide ${readable[i]}`));
    // The knight case: brief, drawing, animation, review and export are all routed.
    const order = ["brief", "pixel-art", "shade-sprite", "animate", "review", "export-game"];
    for (const n of order) assert.ok(routed.includes(n), `routes to ${n}`);
    // The procedure: brief first, the chain as the plan, read each skill, review, export, compromise report.
    for (const re of [/`brief`/, /plan or to-do tool/, /read_guide\("<skill>"\)/, /Review before export/, /Export last/, /Compromise report/, /\*\*Compromises\*\*/]) {
      assert.match(skill.body, re);
    }
    assert.ok(skill.tools.includes("read_guide"), "studio lists read_guide");
    assert.ok(skill.triggers.length && skill.triggers.every((t) => t.includes(" ")), `triggers are phrases: ${skill.triggers.join()}`);
  },
};
