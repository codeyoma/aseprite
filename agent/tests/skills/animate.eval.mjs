// animate: the clip planned with one key (the keys stage, #109), advanced, in-betweens with transform_layer, a squash
// on the landing frame, the clip done (every frame drawn, none repeating), then the filmstrip review.
import { bounds, fakeDocument, rect } from "./_helpers.mjs";

const W = 32;

export default {
  skill: "animate",
  fixture: () => fakeDocument({
    width: W, height: W, frames: 5, tags: [{ name: "bounce", from: 1, to: 5 }],
    layers: [{ name: "Ball", frames: [rect(W, W, [4, 12, 9, 17], [255, 0, 77])] }],
  }),
  steps: [
    { tool: "motion_clip", input: { action: "plan", tag: "bounce", kind: "action", keys: [{ frame: 1, pose: "start" }] } },
    { tool: "motion_clip", input: { action: "advance", tag: "bounce" } },
    { tool: "transform_layer", input: { layer: "Ball", from_frame: 1, to_frame: 5, move: { dx: 16 }, easing: "linear" } },
    { tool: "squash_stretch", input: { layer: "Ball", frame: 5, amount: -0.3 } },
    { tool: "motion_clip", input: { action: "done", tag: "bounce" } },
    { tool: "snapshot", input: { view: "filmstrip", frames: "1-5" } },
  ],
  check(fake, results, assert) {
    const b = [1, 2, 3, 4, 5].map((f) => bounds(fake.cel("Ball", f), W));
    for (const [i, x] of b.entries()) assert.ok(x, `frame ${i + 1} has pixels`);
    // Linear in-betweens: the ball moves right by 4 px a frame.
    assert.deepEqual(b.slice(0, 4).map((x) => x.x0), [4, 8, 12, 16]);
    assert.deepEqual([b[3].w, b[3].h], [6, 6], "in-betweens keep the shape");
    // The squash makes the last frame wider and flatter around x ~ 20..25.
    assert.ok(b[4].w > 6 && b[4].h < 6, `squash: ${JSON.stringify(b[4])}`);
    assert.ok(b[4].x0 <= 20 && b[4].x1 >= 25, `squash stays at the end position: ${JSON.stringify(b[4])}`);
    const said = (i) => results[i].content.find((c) => c.type === "text").text;
    assert.match(said(0), /Draw the key frames 1 now. Edits to frames 2, 3, 4, 5 are undone until motion_clip advance/);
    assert.match(said(1), /Clip "bounce" is in stage "inbetweens"/);
    assert.match(said(4), /Clip "bounce" is done/);
    // The review: all five frames in one numbered image.
    const strip = results[5];
    assert.ok(strip.content.some((c) => c.type === "image"), "the filmstrip is an image");
    assert.match(strip.content.find((c) => c.type === "text").text, /Filmstrip of frames 1-5: 5 frames of 32x32 px/);
  },
};
