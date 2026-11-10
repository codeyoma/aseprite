// brief: a text skill (no tool changes pixels), so the eval checks what the agent is told and that what it is told
// to read exists. The steps read every rule the brief cites; the check holds the SKILL.md to its promise: six
// decisions in a table with defaults, an example stated as decisions (no question), one message, ask only what
// blocks, hold later steps to it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citedRules } from "../../bridge/dist/rules.js";
import { parseSkill } from "../../bridge/dist/guide.js";
import { fakeDocument } from "./_helpers.mjs";

const md = readFileSync(fileURLToPath(new URL("../../skills/brief/SKILL.md", import.meta.url)), "utf8");
const skill = parseSkill(md, "brief", "built-in");
const rules = citedRules(md);
const DECISIONS = ["Size", "Palette", "View", "Light", "Outline", "Destination"];

export default {
  skill: "brief",
  skipLive: "a text skill: nothing to build or read in Aseprite (live: tests/studio_live.mjs)",
  fixture: () => fakeDocument({ width: 32, height: 32, palette: ["#000000", "#ffffff"], layers: [{ name: "Layer 1" }] }),
  steps: rules.map((id) => ({ tool: "read_guide", input: { topic: id } })),
  check: (fake, results, assert) => {
    assert.ok(rules.length >= 5, `the brief cites rules (${rules.join(", ")})`);
    results.forEach((r, i) => assert.ok(r.content[0].text.length > 40, `read_guide ${rules[i]} returned the rule`));
    // The table: one row per decision, in order, each with a reason and a default.
    const rows = skill.body.split("\n").filter((l) => /^\| \*\*/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    assert.deepEqual(rows.map((r) => r[0].replace(/\*/g, "")), DECISIONS, "the six decisions, in order");
    for (const r of rows) assert.ok(r[1].length > 10 && r[2].length > 5, `${r[0]} has a reason and a default`);
    // The example is decisions, not questions, and names each decision.
    const example = skill.body.split("\n").filter((l) => /^\s*>/.test(l)).join(" ");
    for (const d of DECISIONS) assert.match(example, new RegExp(d, "i"), `the example states ${d}`);
    assert.doesNotMatch(example, /\?/, "the example asks no question");
    assert.match(skill.body, /one message, as decisions, not questions/i);
    assert.match(skill.body, /Ask only what truly blocks you/);
    assert.match(skill.body, /Hold to it/);
    assert.match(skill.body, /first message of the turn/, "the brief comes before any other reply");
    // Triggers are phrases, so "brief" in "briefly" never pulls the skill in.
    assert.ok(skill.triggers.length && skill.triggers.every((t) => t.includes(" ")), skill.triggers.join());
  },
};
