// pixel-fx: pick a slash from the library, add a spark, overlay the slash on a 6-frame attack with its
// impact on frame 4, freeze that frame with a hit-stop, then check the effect layers.
import { fakeDocument, opaque, rect, textOf } from "./_helpers.mjs";

const W = 160, H = 112;
// The mage lunges right over the attack: a 10x22 body, 2 px further each frame.
const mage = Array.from({ length: 6 }, (_, i) => rect(W, H, [56 + 2 * i, 78, 65 + 2 * i, 99], [80, 40, 160]));
const sum = (a) => a.reduce((x, y) => x + y, 0);

export default {
  skill: "pixel-fx",
  fixture: () => fakeDocument({
    width: W, height: H, durations: Array(6).fill(100), layer: "Mage",
    palette: ["#00000000", "#000000", "#5028a0"],
    layers: [{ name: "Mage", frames: mage }],
    tags: [{ name: "attack", from: 1, to: 6 }],
  }),
  steps: [
    { tool: "list_fx", input: { query: "slash" } },
    { tool: "add_fx", input: { id: "hit-spark", x: 76, y: 88, start_frame: 4 } },
    { tool: "fx_overlay", input: { id: "sword-slash", tag: "attack", anchor_layer: "Mage", hit_frame: 4 } },
    { tool: "hit_stop", input: { frame: 4, freeze_ms: 120, shake: { amp: 2, ms: 66 } } },
    { tool: "check_fx", input: {} },
  ],
  check(fake, results, assert) {
    const [list, added, overlay, stop, checked] = results.map(textOf);
    assert.match(list, /sword-slash/, "list_fx finds the slash");
    assert.match(added, /hit-spark/);
    assert.match(overlay, /lands on frame 4/, "the slash's impact is on the contact frame");
    assert.match(stop, /\+120/);
    const names = fake.layerNames();
    for (const n of ["AI: fx hit-spark", "AI: fx sword-slash"]) assert.ok(names.includes(n), `${n} in ${names.join(", ")}`);
    const s = fake.active.sprite;
    // The overlay resamples and cuts at the tag, so only the hit-stop (and the spark's added frames) change the timeline.
    const attack = s.tags.find((t) => t.name === "attack");
    assert.equal(attack.from, 1);
    assert.equal(sum(s.durations.slice(0, attack.to)), 600 + 120, "the attack grows by exactly the freeze");
    assert.ok(opaque(fake.cel("AI: fx sword-slash", 4)) > 0, "the slash is on the contact frame");
    assert.ok(opaque(fake.cel("AI: fx hit-spark", 4)) > 0, "the spark is on frame 4");
    assert.match(checked, /^FX check: 0 errors/, checked);
  },
};
