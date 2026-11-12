// The fresh-eyes critic and the blind A/B gate (#76): parsing and the retry,
// rule ids checked against the rules index, the A/B order drawn at random and
// mapped back, the fix guard, and the critic's MCP endpoint. A scripted critic
// (ctx.critic) stands in for the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  __setReviewCheckpointForTest, abRecords, abSheet, askParsed, changedPixels, extractJson, FIX_LIMIT, fixGuard, formatGuard, formatCritique,
  normalizeRuleId, parseAb, parseCritique, reviewCheckpoint, seededRandom,
} from "../dist/critic.js";
import { startHttpEndpoint } from "../dist/http.js";
import { decodePng } from "../dist/image.js";
import { ruleIds } from "../dist/rules.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const KNOWN = ruleIds();

const critiqueJson = (o = {}) => JSON.stringify({
  cold_read: "a small red figure standing above a brown strip",
  score: 4,
  findings: [
    { severity: "NOTE", rule: "rule:char.face", where: "head", issue: "no eyes", fix: "add two dark pixels" },
    { severity: "BLOCKING", rule: "rule:char.extremities", where: "y=24-27", issue: "feet float 3 px above the ground", fix: "move the figure down 3 px" },
    { severity: "worth_fixing", rule: "`rule:made.up`", where: "(3,4)", issue: "stray pixels", fix: "delete them" },
  ],
  first_fix: "put the feet on the ground",
  ...o,
});

/** A scripted critic: replies in order, records what it was asked. */
function scriptedCritic(replies) {
  const asked = [];
  let opened = 0, closed = 0;
  return {
    asked,
    get opened() { return opened; },
    get closed() { return closed; },
    open(label) {
      opened++;
      return {
        ask: async (message, images = []) => {
          asked.push({ label, message, images });
          const r = replies.shift();
          if (r === undefined) throw new Error("no more scripted replies");
          return typeof r === "function" ? r(message, images) : r;
        },
        close: () => { closed++; },
      };
    },
  };
}

test("parseCritique: findings by severity, unknown rule ids flagged, the ship rule", () => {
  const c = parseCritique(critiqueJson(), KNOWN);
  assert.equal(c.score, 4);
  assert.deepEqual(c.findings.map((f) => f.severity), ["BLOCKING", "WORTH FIXING", "NOTE"]);
  assert.equal(c.findings[0].rule, "char.extremities");
  assert.equal(c.findings[0].unknownRule, false);
  assert.equal(c.findings[1].rule, "made.up");
  assert.equal(c.findings[1].unknownRule, true);
  assert.deepEqual(c.unknownRules, ["made.up"]);
  assert.equal(c.ship, false);
  const out = formatCritique(c);
  assert.match(out, /^Critique: 4\/10\. Not ready: 1 BLOCKING finding/);
  assert.match(out, /\[rule:made\.up \(unknown rule id\)\]/);
  assert.match(out, /Unknown rule ids .*rule:made\.up/);

  const good = parseCritique(critiqueJson({ score: 7, findings: [{ severity: "NOTE", rule: "char.face", issue: "fine" }] }), KNOWN);
  assert.equal(good.ship, true);
  assert.equal(parseCritique(critiqueJson({ score: 9 }), KNOWN).ship, false, "a BLOCKING finding stops the ship at any score");
  assert.equal(parseCritique(critiqueJson({ score: 6.5, findings: [] }), KNOWN).ship, false);
  // No rule cited: flagged, but not an unknown id.
  const none = parseCritique(critiqueJson({ findings: [{ severity: "NOTE", issue: "x" }] }), KNOWN);
  assert.equal(none.findings[0].unknownRule, true);
  assert.deepEqual(none.unknownRules, []);
  assert.match(formatCritique(none), /\[no rule cited\]/);
});

test("parse errors say what is wrong", () => {
  assert.throws(() => parseCritique("I think it's a 6/10.", KNOWN), /no JSON object/);
  assert.throws(() => parseCritique(critiqueJson({ score: "6" }), KNOWN), /score must be a number/);
  assert.throws(() => parseCritique(critiqueJson({ score: 11 }), KNOWN), /score must be a number from 0 to 10/);
  assert.throws(() => parseCritique(critiqueJson({ cold_read: "" }), KNOWN), /cold_read is missing/);
  assert.throws(() => parseCritique(critiqueJson({ findings: [{ severity: "MAJOR", issue: "x" }] }), KNOWN), /severity must be/);
  // Fenced or surrounded by prose still parses.
  assert.equal(parseCritique("Here:\n```json\n" + critiqueJson() + "\n```", KNOWN).score, 4);
  assert.equal(parseCritique("Result " + critiqueJson() + " done", KNOWN).score, 4);
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(normalizeRuleId("`rule:Char.Face`"), "char.face");
  assert.equal(normalizeRuleId("rules://char.face"), "char.face");
});

test("askParsed retries once in the same session, then gives up", async () => {
  const critic = scriptedCritic(["not json", critiqueJson()]);
  const s = critic.open("c");
  const r = await askParsed(s, "critique", [], (t) => parseCritique(t, KNOWN));
  assert.equal(r.retried, true);
  assert.equal(r.value.score, 4);
  assert.equal(critic.asked.length, 2);
  assert.match(critic.asked[1].message, /could not be used: no JSON object.*only the JSON object/s);

  const bad = scriptedCritic(["nope", "still nope", critiqueJson()]);
  await assert.rejects(askParsed(bad.open("c"), "x", [], (t) => parseCritique(t, KNOWN)), /did not parse twice/);
  assert.equal(bad.asked.length, 2, "only one retry");
});

test("parseAb: winner, rules checked", () => {
  const v = parseAb(JSON.stringify({ winner: "b", reason: "feet on the ground", rules: ["rule:char.extremities", "rule:nope"] }), KNOWN);
  assert.equal(v.winner, "B");
  assert.deepEqual(v.unknownRules, ["nope"]);
  assert.equal(parseAb('{"winner":"TIE"}', KNOWN).winner, "tie");
  assert.throws(() => parseAb('{"winner":"both"}', KNOWN), /winner must be/);
});

// A 32x32 figure whose feet float 3 px above a ground strip.
const W = 32;
const BODY = [255, 0, 77], GROUND = [120, 70, 30];
function figureDoc(extra = {}) {
  return fakeDocument({
    width: W, height: W, palette: ["#000000", "#ff004d", "#78461e"],
    layers: [
      { name: "Ground", frames: [rect(W, W, [0, 28, 31, 31], GROUND)] },
      { name: "Body", frames: [rect(W, W, [12, 10, 19, 24], BODY)] },
    ],
    extra: { diff_visual: (p) => ({ saved: p.save, width: W, height: W, changed: 0 }), ...extra },
  });
}

test("critique: the critic sees images, state and the rules index, never the brief; unknown ids flagged", async () => {
  const fake = figureDoc();
  const critic = scriptedCritic(["```\nnot json\n", critiqueJson()]);
  fake.critic = critic;
  const r = await runTool(findTool("critique"), { what: "a 32x32 character standing on the ground" }, fake);
  assert.ok(!r.isError, textOf(r));
  const out = textOf(r);
  assert.match(out, /Critique: 4\/10/);
  assert.match(out, /feet float 3 px above the ground/);
  assert.match(out, /rule:made\.up \(unknown rule id\)/);
  assert.match(out, /first reply did not parse; it was asked once more/);
  assert.equal(critic.opened, 1);
  assert.equal(critic.closed, 1, "the critic is closed after its verdict");
  const first = critic.asked[0];
  assert.equal(first.images.length, 1);
  assert.equal(first.images[0].mimeType, "image/png");
  const png = decodePng(Buffer.from(first.images[0].data, "base64"));
  assert.equal(png.width, 512, "one frame at 16x");
  assert.match(first.message, /says it is: a 32x32 character standing on the ground/);
  assert.match(first.message, /32x32 px, rgb, 1 frame\./);
  assert.match(first.message, /Layers \(top first\): L\d+ Body, L\d+ Ground/);
  assert.match(first.message, /rules\/characters \(char\)/);
  assert.match(first.message, /"cold_read"/);

  // The one-liner is short: a brief does not fit.
  const long = await runTool(findTool("critique"), { what: "x".repeat(200) }, fake);
  assert.ok(long.isError);
  // Without a critic runner (CLI): a clear failure.
  const none = await runTool(findTool("critique"), {}, figureDoc());
  assert.match(textOf(none), /critic is not available/);
});

test("critique of an animation shows the filmstrip", async () => {
  const fake = fakeDocument({
    width: 16, height: 16, frames: 3,
    layers: [{ name: "Ball", frames: [rect(16, 16, [2, 2, 5, 5], BODY), rect(16, 16, [6, 2, 9, 5], BODY), rect(16, 16, [10, 2, 13, 5], BODY)] }],
  });
  fake.critic = scriptedCritic([critiqueJson({ score: 8, findings: [] })]);
  const r = await runTool(findTool("critique"), {}, fake);
  assert.match(textOf(r), /Critique: 8\/10\. Ship it/);
  assert.match(fake.critic.asked[0].message, /filmstrip/);
});

test("the fix guard: at most 25% of a layer's opaque pixels, small fixes always pass", () => {
  const img = (data) => ({ width: W, height: W, data });
  const body = rect(W, W, [0, 0, 9, 9], BODY); // 100 px
  const cp = { name: "g", title: "t", width: W, height: W, frames: [1], composite: new Map(),
    layers: new Map([["L1", { name: "Body", images: new Map([[1, img(body)]]) }], ["L2", { name: "Empty", images: new Map([[1, img(new Uint8Array(W * W * 4))]]) }]]) };
  const withBody = (data, more = []) => new Map([["L1", { name: "Body", images: new Map([[1, img(data)]]) }],
    ["L2", { name: "Empty", images: new Map([[1, img(new Uint8Array(W * W * 4))]]) }], ...more]);

  const small = rect(W, W, [0, 0, 9, 9], BODY);
  small.set([0, 0, 0, 255], 0); // 1 px
  const g1 = fixGuard(cp, withBody(small));
  assert.equal(g1.ok, true);
  assert.equal(g1.layers.find((l) => l.id === "L1").changed, 1);

  const quarter = rect(W, W, [0, 0, 9, 9], BODY);
  for (let x = 0; x < 10; x++) for (let y = 0; y < 2; y++) quarter.set([0, 0, 0, 255], (y * W + x) * 4); // 20 px
  assert.equal(fixGuard(cp, withBody(quarter)).ok, true, "20% passes");

  const redraw = rect(W, W, [5, 5, 14, 14], BODY); // moved: 75 px left, 75 px new
  const g2 = fixGuard(cp, withBody(redraw));
  assert.equal(g2.ok, false);
  const l1 = g2.layers.find((l) => l.id === "L1");
  assert.ok(l1.over && l1.share > FIX_LIMIT, JSON.stringify(l1));
  // Motion mode (#111): the same move keeps the part's size, so it passes as a motion fix; a growth does not.
  const moved = fixGuard(cp, withBody(redraw), FIX_LIMIT, true);
  assert.equal(moved.ok, true);
  assert.equal(moved.layers.find((l) => l.id === "L1").moved, true);
  assert.match(formatGuard(moved, "g"), /moved: same size every frame, allowed as a motion fix/);
  assert.equal(fixGuard(cp, withBody(rect(W, W, [5, 5, 18, 18], BODY)), FIX_LIMIT, true).ok, false, "a part that grows is still a redraw");

  // Drawing on a layer that was empty, or on a new layer, is adding, not redrawing.
  const added = withBody(body, [["L9", { name: "Shadow", images: new Map([[1, img(rect(W, W, [0, 20, 31, 31], GROUND))]]) }]]);
  added.get("L2").images.set(1, img(rect(W, W, [0, 0, 31, 31], GROUND)));
  const g3 = fixGuard(cp, added);
  assert.equal(g3.ok, true);
  assert.deepEqual(g3.added, ["L9 Shadow"]);

  // A removed layer fails it.
  const gone = fixGuard(cp, new Map([["L2", withBody(body).get("L2")]]));
  assert.equal(gone.ok, false);
  assert.ok(gone.layers.find((l) => l.id === "L1").removed);

  assert.deepEqual(changedPixels(img(body), img(body)), { changed: 0, opaque: 100 });
});

test("diff_visual save keeps a per-layer copy; ab_compare refuses a redraw without asking a critic", async () => {
  const fake = figureDoc();
  fake.critic = scriptedCritic([]);
  const saved = await runTool(findTool("diff_visual"), { save: "before-fix" }, fake);
  assert.match(textOf(saved), /Saved checkpoint "before-fix"\. Kept 2 layers x 1 frame for the fix guard and ab_compare\./);
  const cp = reviewCheckpoint("before-fix");
  assert.deepEqual(cp.frames, [1]);
  // Redraw the body somewhere else: far over 25%.
  await fake.request("put_image", { layer: "Body", frame: 1, width: W, height: W, rgba: Buffer.from(rect(W, W, [2, 2, 9, 16], BODY)).toString("base64"), x: 0, y: 0 });
  const r = await runTool(findTool("ab_compare"), { checkpoint: "before-fix" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Fix round refused: the fix redrew instead of fixing\. L\d+ Body changed more than 25%/);
  assert.match(textOf(r), /No comparison was run/);
  assert.equal(fake.critic.opened, 0);
  // critique with the checkpoint refuses the same way.
  const c = await runTool(findTool("critique"), { checkpoint: "before-fix" }, fake);
  assert.match(textOf(c), /Fix round refused[\s\S]*No critique was run/);
});

test("ab_compare: a blind, seeded order, mapped back after the verdict", async () => {
  const seen = { a: 0, b: 0 };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const fake = figureDoc();
    await runTool(findTool("diff_visual"), { save: "cp" }, fake);
    // The fix: the feet down to the ground, 4 rows of 8 px (32 of 120 opaque px of Body would be over 25%,
    // so move only the bottom rows: add 3 rows below, keep the rest).
    const fixed = rect(W, W, [12, 10, 19, 24], BODY);
    for (let y = 25; y <= 27; y++) for (let x = 13; x <= 14; x++) fixed.set([...BODY, 255], (y * W + x) * 4);
    await fake.request("put_image", { layer: "Body", frame: 1, width: W, height: W, rgba: Buffer.from(fixed).toString("base64"), x: 0, y: 0 });
    fake.random = seededRandom(seed);
    // The critic decodes the sheet and picks the row whose figure reaches lower (the grounded one).
    fake.critic = scriptedCritic([(message, images) => {
      assert.doesNotMatch(message, /checkpoint|before|after|fix/i, "the critic is not told which is which");
      const png = decodePng(Buffer.from(images[0].data, "base64"));
      const lowest = (top) => {
        let low = -1;
        for (let y = top; y < top + png.height / 2; y++) for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 77) low = y - top;
        }
        return low;
      };
      const winner = lowest(png.height / 2) > lowest(0) ? "B" : "A";
      return JSON.stringify({ cold_read_a: "figure", cold_read_b: "figure", winner, reason: "the feet touch the ground", rules: ["rule:char.extremities"] });
    }]);
    const r = await runTool(findTool("ab_compare"), { checkpoint: "cp", what: "a 32x32 character" }, fake);
    assert.ok(!r.isError, textOf(r));
    const out = textOf(r);
    assert.match(out, /Verdict: the canvas now \(after the fix\) is better \(shown to the critic as [AB]\)\. Keep the fix\./);
    assert.match(out, /Fix guard passed/);
    const rec = abRecords().at(-1);
    assert.equal(rec.winner, "b");
    assert.match(out, new RegExp(`Blind order \\(comparison #${rec.id}\\): A was ${rec.shown.A === "a" ? "checkpoint" : "the canvas now"}`));
    seen[rec.shown.A]++;
    // The same seed draws the same order.
    assert.equal(seededRandom(seed)() < 0.5, rec.shown.A === "b");
  }
  assert.ok(seen.a > 0 && seen.b > 0, `both orders drawn: ${JSON.stringify(seen)}`);
});

test("ab_compare: a worse version loses; a and b by layer", async () => {
  const fake = fakeDocument({
    width: W, height: W, palette: ["#000000", "#ff004d"],
    layers: [
      { name: "Good", frames: [rect(W, W, [12, 10, 19, 27], BODY)] },
      { name: "Bad", frames: [rect(W, W, [12, 10, 19, 24], BODY)] },
    ],
  });
  fake.random = seededRandom(42);
  fake.critic = scriptedCritic([() => {
    const rec = abRecords().at(-1);
    // Pick whichever label shows "Good" (the caller's a): the test reads the record a real critic can't see.
    return JSON.stringify({ winner: rec.shown.A === "a" ? "A" : "B", reason: "grounded" });
  }]);
  const r = await runTool(findTool("ab_compare"), { a: { layer: "Good" }, b: { layer: "Bad" } }, fake);
  assert.match(textOf(r), /Verdict: a \(layer "Good", frame 1\) is better/);
  assert.doesNotMatch(textOf(r), /Keep the fix/);
  const sheet = abSheet([{ width: 4, height: 4, data: rect(4, 4, [0, 0, 1, 1], BODY) }],
    [{ width: 4, height: 4, data: rect(4, 4, [2, 2, 3, 3], BODY) }]);
  assert.equal(sheet.zoom, 16);
  assert.ok(sheet.image.height > sheet.image.width, "A above B");
  // Bad input.
  assert.match(textOf(await runTool(findTool("ab_compare"), { a: { layer: "Good" } }, fake)), /both a and b/);
  assert.match(textOf(await runTool(findTool("ab_compare"), { checkpoint: "missing" }, fake)), /No checkpoint named "missing"/);
});

test("the critics' endpoint is read-only and cannot start agents; the lead's has critique", async () => {
  const link = { request: async () => ({ result: { ok: true } }) };
  const ep = await startHttpEndpoint(link, "tk");
  const list = async (url) => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer tk" } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  };
  try {
    assert.equal(ep.criticUrl, ep.url + "/critic");
    const critic = await list(ep.criticUrl);
    for (const n of ["critique", "ab_compare", "spawn_agents", "execute_lua", "write_pixels"]) assert.ok(!critic.includes(n), `critic has ${n}`);
    for (const n of ["snapshot", "read_pixels", "check", "read_guide", "get_state"]) assert.ok(critic.includes(n), `critic lacks ${n}`);
    // The lead's endpoint lists them with every tool listed (ASEPRITE_AGENT_TOOLS=all; by default they are deferred, #88).
    process.env.ASEPRITE_AGENT_TOOLS = "all";
    const lead = await list(ep.url);
    assert.ok(lead.includes("critique") && lead.includes("ab_compare"));
    process.env.ASEPRITE_AGENT_TOOLS = "all";
    const criticAll = await list(ep.criticUrl);
    for (const n of ["critique", "ab_compare", "spawn_agents", "execute_lua"]) assert.ok(!criticAll.includes(n), `critic (all) has ${n}`);
  } finally {
    delete process.env.ASEPRITE_AGENT_TOOLS;
    ep.server.close();
  }
});

test("a checkpoint can be planted for tests", () => {
  __setReviewCheckpointForTest({ name: "planted", title: "", width: 1, height: 1, frames: [1], composite: new Map(), layers: new Map() });
  assert.ok(reviewCheckpoint("planted"));
});

test("ab_compare: a timing-only change is compared with both timings, still blind (#98)", async () => {
  const { timingChanges, describeTiming } = await import("../dist/critic.js");
  assert.deepEqual(timingChanges({ durations: [100, 100], tags: [{ name: "walk", from: 1, to: 2 }] },
    { durations: [100, 300], tags: [{ name: "walk", from: 1, to: 2, direction: "pingpong" }] }),
  ["frame 2: 100 -> 300 ms", "tag walk: 1-2 forward -> 1-2 pingpong"]);
  assert.equal(describeTiming([100, 100], [{ name: "idle", from: 1, to: 2, direction: "reverse" }]), "100 ms each, tags idle 1-2 reverse");

  const body = rect(W, W, [12, 10, 19, 27], BODY);
  const fake = fakeDocument({ width: W, height: W, frames: 2, palette: ["#000000", "#ff004d"], layers: [{ name: "Body", frames: [body, body] }],
    extra: { diff_visual: (p) => ({ saved: p.save, width: W, height: W, changed: 0 }) } });
  await runTool(findTool("diff_visual"), { save: "cp" }, fake);
  // Only the timing changes: frame 2 is held three times longer.
  await fake.request("put_images", { images: [], durations: [{ frame: 2, ms: 300 }] });
  fake.random = seededRandom(3);
  let asked = "";
  fake.critic = scriptedCritic([(message) => {
    asked = message;
    return JSON.stringify({ winner: "A", reason: "the hold reads" });
  }]);
  const r = await runTool(findTool("ab_compare"), { checkpoint: "cp", what: "a 32x32 character" }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.doesNotMatch(textOf(r), /Nothing changed/);
  assert.match(asked, /play with different timing: A (100 ms each|durations 100, 300 ms); B (100 ms each|durations 100, 300 ms)/);
  assert.doesNotMatch(asked, /checkpoint|before|after|fix/i, "the critic is not told which is which");
});
