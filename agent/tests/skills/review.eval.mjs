// review: a critique, a checkpoint, a small fix (the feet down to the ground), then the blind A/B with its guard.
// A scripted critic stands in for the model: it flags the floating feet, and in the A/B it picks the row whose
// figure reaches lower, so the eval checks the loop's mechanics, not a model's taste.
import { decodePng } from "../../bridge/dist/image.js";
import { seededRandom } from "../../bridge/dist/critic.js";
import { fakeDocument, rect } from "./_helpers.mjs";

const W = 32;
const BODY = [255, 0, 77];

/** The lowest row with the body's color in each half (top: A, bottom: B) of the A/B sheet. */
function lowestRows(png) {
  const half = png.height / 2;
  const low = [-1, -1];
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    if (png.data[i] === BODY[0] && png.data[i + 1] === BODY[1] && png.data[i + 2] === BODY[2]) low[y < half ? 0 : 1] = y % half;
  }
  return low;
}

const asked = [];
const replies = [
  JSON.stringify({
    cold_read: "a red block figure above a brown strip",
    score: 4,
    findings: [{ severity: "BLOCKING", rule: "rule:char.extremities", where: "x=13-14, y=25-27", issue: "the feet float 3 px above the ground", fix: "extend the legs to y=27" }],
    first_fix: "put the feet on the ground",
  }),
  (message, images) => {
    const [a, b] = lowestRows(decodePng(Buffer.from(images[0].data, "base64")));
    return JSON.stringify({ cold_read_a: "figure", cold_read_b: "figure", winner: b > a ? "B" : "A", reason: "its feet touch the ground" });
  },
];

export default {
  skill: "review",
  skipLive: "critique and ab_compare need a model; the scripted critic exists only on the fake (live: tests/critic_live.mjs)",
  fixture: () => {
    const fake = fakeDocument({
      width: W, height: W, palette: ["#000000", "#ff004d", "#78461e"],
      layers: [
        { name: "Ground", frames: [rect(W, W, [0, 28, 31, 31], [120, 70, 30])] },
        { name: "Body", frames: [rect(W, W, [12, 10, 19, 24], BODY)] },
      ],
      // diff_visual's checkpoint lives in the extension; the bridge keeps its own copy through snapshots.
      extra: { diff_visual: (p) => ({ saved: p.save, width: W, height: W, changed: 0 }) },
    });
    fake.random = seededRandom(7);
    fake.critic = {
      open: () => ({
        ask: async (message, images = []) => {
          asked.push(message);
          const r = replies.shift();
          return typeof r === "function" ? r(message, images) : r;
        },
        close() {},
      }),
    };
    return fake;
  },
  steps: [
    { tool: "critique", input: { what: "a 32x32 character" } },
    { tool: "diff_visual", input: { save: "review-1" } },
    { tool: "write_pixels", input: { layer: "Body", x: 13, y: 25, rows: ["r r . . . r r", "r r . . . r r", "r r . . . r r"], legend: { r: "#ff004d" } } },
    { tool: "ab_compare", input: { checkpoint: "review-1", what: "a 32x32 character" } },
  ],
  check(fake, results, assert) {
    const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.match(text(results[0]), /Critique: 4\/10\. Not ready: 1 BLOCKING finding/);
    assert.match(text(results[0]), /feet float/);
    assert.match(text(results[1]), /Kept 2 layers x 1 frame/);
    // 12 px changed of 120 opaque px of Body: 10%, under the 25% guard.
    assert.match(text(results[3]), /Fix guard passed/);
    assert.match(text(results[3]), /L\d+ Body: 12 px changed of 120 opaque \(10%\)/);
    assert.match(text(results[3]), /Verdict: the canvas now \(after the fix\) is better .*Keep the fix\./);
    assert.ok(!asked.some((m) => /floating|brief|fix the feet/.test(m.split("Rules index:")[0])), "the critics never see what was changed");
  },
};
