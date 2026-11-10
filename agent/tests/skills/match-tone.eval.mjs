// match-tone: color_stats describes how a dark layer differs from a bright
// reference; adjust_tone with match_to moves it towards the reference.
import { fakeDocument, rect, textOf } from "./_helpers.mjs";

const W = 8;
const ART = [[40, 60, 30], [70, 90, 50], [20, 30, 20]];
const REF = [[150, 210, 120], [200, 240, 170], [110, 160, 90]];
const bands = (cols) => {
  const d = new Uint8Array(W * W * 4);
  cols.forEach((c, i) => d.set(rect(W, W, [0, i * 2, W - 1, i * 2 + 1], c).subarray(i * 2 * W * 4, (i * 2 + 2) * W * 4), i * 2 * W * 4));
  return d;
};
const luma = (d) => {
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
  return s / n;
};

export default {
  skill: "match-tone",
  fixture: () => fakeDocument({ width: W, height: W, layers: [{ name: "Ref", frames: [bands(REF)] }, { name: "Art", frames: [bands(ART)] }] }),
  steps: [
    { tool: "color_stats", input: { source: "layer", layer: "Art", compare_to: { source: "layer", layer: "Ref" } } },
    { tool: "adjust_tone", input: { layer: "Art", match_to: { source: "layer", layer: "Ref" } } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /Compared with it, layer Art is .*darker/);
    assert.match(textOf(results[1]), /Adjusted 3 colors/);
    const before = luma(bands(ART)), after = luma(fake.cel("Art")), ref = luma(bands(REF));
    assert.ok(Math.abs(after - ref) < Math.abs(before - ref) / 2, `lightness ${before.toFixed(0)} -> ${after.toFixed(0)}, reference ${ref.toFixed(0)}`);
    assert.ok(Buffer.from(fake.cel("Ref")).equals(Buffer.from(bands(REF))), "the reference is untouched");
  },
};
