// Animation helpers (#42): RotSprite transforms, arcs, squash and stretch, smears.
import { test } from "node:test";
import { judgeCycle } from "../dist/walk_check.js";

import assert from "node:assert/strict";
import { along, bounds, ease, scale2x, smear, squashStretch, transform } from "../dist/animation.js";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument } from "./helpers/fake_document.mjs";

function sword(W = 40) {
  const d = new Uint8Array(W * W * 4);
  const put = (x, y, c) => d.set([...c, 255], (y * W + x) * 4);
  for (let y = 6; y < 22; y++) { put(19, y, [24, 20, 37]); put(20, y, [200, 210, 230]); put(21, y, [24, 20, 37]); }
  for (let x = 16; x < 25; x++) put(x, 22, [171, 82, 54]);
  for (let y = 23; y < 28; y++) put(20, y, [120, 60, 40]);
  return { width: W, height: W, data: d };
}
const colors = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(img.data.slice(i, i + 3).join()); return s; };
const count = (img) => { let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++; return n; };

test("scale2x keeps colors and doubles size", () => {
  const s = scale2x(sword());
  assert.equal(s.width, 80);
  assert.deepEqual(colors(s), colors(sword()));
});

test("rotation and scaling add no colors and keep the shape's size", () => {
  const img = sword();
  for (const angle of [15, 30, 45, 90, 180]) {
    const r = transform(img, { angle, px: 20, py: 17 });
    for (const c of colors(r)) assert.ok(colors(img).has(c), `angle ${angle}: new color ${c}`);
    assert.ok(Math.abs(count(r) - count(img)) / count(img) < 0.2, `angle ${angle}: ${count(r)} vs ${count(img)} px`);
  }
  const turned = bounds(transform(img, { angle: 90, px: 20, py: 17 }));
  assert.ok(turned.w > turned.h, "90 degrees lies the sword on its side");
  assert.deepEqual(colors(transform(img, { dx: 3 })), colors(img));
});

test("along: eased, arced path that ends at the target", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.25) < 0.25, "ease-in-out starts slow");
  const end = along({ dx: 10, angle: 90 }, 1, 6);
  assert.deepEqual([end.dx, end.dy, end.angle], [10, 0, 90]);
  assert.equal(along({ dx: 10 }, 0.5, 6, "linear").dy, -6, "highest at the middle");
});

test("squash keeps the feet on the ground; stretch makes it taller", () => {
  const img = sword(), b = bounds(img);
  const sq = bounds(squashStretch(img, -0.3)), st = bounds(squashStretch(img, 0.3));
  assert.equal(sq.y + sq.h, b.y + b.h);
  assert.equal(st.y + st.h, b.y + b.h);
  assert.ok(sq.h < b.h && sq.w > b.w && st.h > b.h);
});

test("a smear covers the path between two poses", () => {
  const a = sword(), b = transform(a, { dx: 12 });
  const s = smear(a, b);
  const sb = bounds(s), ab = bounds(a), bb = bounds(b);
  assert.equal(sb.x, ab.x);
  assert.equal(sb.x + sb.w, bb.x + bb.w);
  for (const c of colors(s)) assert.ok(colors(a).has(c));
});

test("transform_layer writes frames after from_frame", async () => {
  const img = sword();
  const calls = [];
  const fake = {
    async request(m, p) {
      calls.push({ m, p });
      if (m === "get_state") return { result: { activeFrame: 1, activeLayerId: "L1", activeSprite: { filename: "Sprite", width: 40, height: 40, frames: Array(6).fill(100).map((durationMs) => ({ durationMs })), layers: [{ id: "L1", name: "Sword" }], tags: [], palette: { colors: [] } } } };
      if (m === "snapshot") return { result: { width: 40, height: 40 }, binary: Buffer.from(img.data) };
      return { result: {} };
    },
  };
  const r = await runTool(findTool("transform_layer"), { layer: "Sword", from_frame: 1, to_frame: 5, move: { angle: 90, pivot_x: 20, pivot_y: 27 }, arc: 3 }, fake);
  // One write for every frame (#101).
  const puts = calls.filter((c) => c.m === "put_images");
  assert.equal(puts.length, 1);
  assert.equal(calls.filter((c) => c.m === "put_image").length, 0);
  assert.deepEqual(puts[0].p.images.map((i) => i.frame), [2, 3, 4, 5]);
  assert.match(r.content[0].text, /frames 2-5 \(4 steps, ease-in-out, arc 3px\)/);
  const bad = await runTool(findTool("transform_layer"), { layer: "Sword", from_frame: 1, to_frame: 9, move: { dx: 1 } }, fake);
  assert.equal(bad.isError, true);
});

test("sub-pixel shift: edges change shade, the drawing doesn't jump", async () => {
  const { subpixelShift, imageColors } = await import("../dist/animation.js");
  const W = 8, H = 3, d = new Uint8Array(W * H * 4);
  // A dark background row with a bright 2 px block at x 2-3.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(x === 2 || x === 3 ? [240, 220, 120, 255] : [30, 30, 60, 255], (y * W + x) * 4);
  const ramp = [{ r: 30, g: 30, b: 60, a: 255 }, { r: 135, g: 125, b: 90, a: 255 }, { r: 240, g: 220, b: 120, a: 255 }];
  const half = subpixelShift({ width: W, height: H, data: d }, 0.5, 0, ramp);
  const row = (img) => [...Array(W)].map((_, x) => img.data[x * 4]);
  // Half a pixel right: x 2 and 4 take the middle shade, x 3 stays bright.
  assert.deepEqual(row(half), [30, 30, 135, 240, 135, 30, 30, 30]);
  const whole = subpixelShift({ width: W, height: H, data: d }, 1, 0, ramp);
  assert.deepEqual(row(whole), [0, 30, 30, 240, 240, 30, 30, 30], "nothing moves into column 0");
  assert.equal(imageColors({ width: W, height: H, data: d }).length, 2);
});

test("subpixel_move writes the in-between frames", async () => {
  const { fakeDocument } = await import("./helpers/fake_document.mjs");
  const { findTool, runTool } = await import("../dist/tools.js");
  const W = 8, d = new Uint8Array(W * W * 4);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) d.set([240, 220, 120, 255], (y * W + x) * 4);
  const fake = fakeDocument({ width: W, height: W, frames: 3, layers: [{ name: "Blob", frames: [d] }], palette: ["#78704c", "#f0dc78"] });
  const r = await runTool(findTool("subpixel_move"), { layer: "Blob", from_frame: 1, to_frame: 3, dy: 1 }, fake);
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /steps of 0\.50 px/);
  assert.ok(fake.cel("Blob", 2) && fake.cel("Blob", 3));
  assert.equal(fake.cel("Blob", 3)[(6 * W + 3) * 4 + 3], 255, "a whole pixel down by frame 3");
});

test("multi-frame animation tools write once: one undo step; a bad frame writes nothing (#101)", async () => {
  const { fakeDocument } = await import("./helpers/fake_document.mjs");
  const { findTool, runTool } = await import("../dist/tools.js");
  const W = 8, d = new Uint8Array(W * W * 4);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 4; x++) d.set([200, 40, 40, 255], (y * W + x) * 4);
  const fresh = () => fakeDocument({ width: W, height: W, frames: 4, layers: [{ name: "Arm", frames: [d, d, d, d] }] });
  const writes = (fake) => fake.calls.filter((c) => ["put_image", "put_images"].includes(c.method));

  const rot = fresh();
  const r1 = await runTool(findTool("rotate_layer"), { layer: "Arm", frames: [1, 2, 2, 3], angle: 90 }, rot);
  assert.ok(!r1.isError, r1.content[0].text);
  assert.equal(writes(rot).length, 1, "one write");
  assert.deepEqual(writes(rot)[0].params.images.map((i) => i.frame), [1, 2, 3], "a repeated frame is rotated once");
  assert.match(r1.content[0].text, /in 3 frame/);

  const bad = fresh();
  const r2 = await runTool(findTool("rotate_layer"), { layer: "Arm", frames: [1, 9], angle: 90 }, bad);
  assert.equal(r2.isError, true);
  assert.equal(writes(bad).length, 0, "nothing written when a later frame is invalid");

  const sub = fresh();
  await runTool(findTool("subpixel_move"), { layer: "Arm", from_frame: 1, to_frame: 4, dx: 1 }, sub);
  assert.equal(writes(sub).length, 1);
  assert.deepEqual(writes(sub)[0].params.images.map((i) => i.frame), [2, 3, 4]);
});

// Walk limbs (#99): frames 1 and 4 of benchmark run 2026-11-11-claude-6, which both judges marked "the arm swings
// with the same-side leg". N is the near arm and near leg (navy), g the far leg, B the shirt, s skin.
const RUN6 = {
  1: [
    "........................", "........................", "........................", "........................",
    ".........sssssss........", ".........sssssss........", ".........sssssss........", ".........sssskss........",
    ".........sssssss........", ".........sssssss........", ".........sssssss........", ".........BBBBBBB........",
    ".........BBNNBBB........", ".........BBNNBBB........", ".........BNNBBBB........", "........NNNBBBBB........",
    ".......NNBBBBBBBN.......", ".......ssBBBBBBBs.......", ".........BBBBBBB........", ".........BBBBBBB........",
    ".........BBBBBBB........", "...........gg...........", "...........gg...........", "...........Ngg..........",
    "..........NNgg..........", "..........NNgg..........", "..........NNgg..........", ".........NN..gg.........",
    ".........NN..gg.........", "........NN....gg........", "........NN....ggg.......", "........................",
  ],
  4: [
    "........................", "........................", "........................", "........................",
    ".........sssssss........", ".........sssssss........", ".........sssssss........", ".........sssskss........",
    ".........sssssss........", ".........sssssss........", ".........sssssss........", ".........BBBBBBB........",
    ".........BBNNBBB........", ".........BBNNBBB........", ".........BBBNNBB........", "........NBBBBNNN........",
    ".......NNBBBBBBNN.......", ".......ssBBBBBBss.......", ".........BBBBBBB........", ".........BBBBBBB........",
    ".........BBBBBBB........", "...........gg...........", "...........gg...........", "...........ggN..........",
    "..........ggNN..........", "..........ggNN..........", "..........ggNN..........", ".........gg..NN.........",
    ".........gg..NN.........", "........gg....NN........", "........gg....NNN.......", "........................",
  ],
};
const KEY = { N: [29, 43, 83], g: [60, 60, 90], B: [41, 120, 255], s: [255, 204, 170], k: [24, 20, 37] };
function asciiImage(rows) {
  const width = rows[0].length, height = rows.length, data = new Uint8Array(width * height * 4);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (KEY[ch]) data.set([...KEY[ch], 255], (y * width + x) * 4); }));
  return { width, height, data };
}
/** The same frame with the near arm moved to the other side of the shoulder (mirrored about x = 11.5 in rows 12-17). */
function swapArm(rows) {
  return rows.map((r, y) => {
    if (y < 12 || y > 17) return r;
    const arm = [...r].map((ch) => (ch === "N" || (y === 17 && ch === "s") ? ch : "."));
    const rest = [...r].map((ch, x) => (arm[x] !== "." ? (x >= 9 && x <= 15 ? "B" : ".") : ch));
    for (let x = 0; x < 24; x++) if (arm[x] !== ".") { const m = 23 - x; rest[m] = arm[x]; }
    return rest.join("");
  });
}

test("walk limbs: the benchmark's same-side arm swing is an error at both contacts (#99)", async () => {
  const { judgeWalk, limbMask, readLimb } = await import("../dist/walk_check.js");
  const arm = { colors: ["#1d2b53"], rows: [11, 17] }, leg = { colors: ["#1d2b53"], rows: [21, 30] };
  const read = (rows, frame) => {
    const img = asciiImage(rows);
    return { frame, arm: readLimb(limbMask(img, arm), img.width, "right"), leg: readLimb(limbMask(img, leg), img.width, "right") };
  };
  const bad = judgeWalk([read(RUN6[1], 1), read(RUN6[4], 4)]);
  assert.equal(bad.status, "errors");
  assert.equal(bad.errors.filter((e) => /both swing/.test(e)).length, 2, bad.errors.join("\n"));
  const c1 = read(RUN6[1], 1);
  assert.ok(c1.arm.offset < -1 && c1.leg.offset < -1, JSON.stringify(c1));

  const good = judgeWalk([read(swapArm(RUN6[1]), 1), read(swapArm(RUN6[4]), 4)]);
  assert.equal(good.status, "ok", JSON.stringify(good));

  const sameBack = judgeWalk([read(RUN6[1], 1), read(RUN6[1], 4)]);
  assert.ok(sameBack.errors.some((e) => /near arm swings back at both contacts/.test(e)), sameBack.errors.join("\n"));

  const none = judgeWalk([{ frame: 1, arm: { pixels: 0 }, leg: c1.leg }, read(RUN6[4], 4)]);
  assert.ok(none.unverifiable.some((u) => /frame 1: no near arm pixels/.test(u)));
});

test("walk_check finds 'near arm'/'near leg' layers, stores the limbs, and reruns without arguments (#99)", async () => {
  const cel = (rows, ch) => {
    const img = asciiImage(rows.map((r) => [...r].map((c) => (c === ch ? "N" : ".")).join("")));
    return { x: 0, y: 0, width: img.width, height: img.height, data: img.data };
  };
  const armRows = (rows) => rows.map((r, y) => (y >= 11 && y <= 17 ? r : ".".repeat(24)));
  const legRows = (rows) => rows.map((r, y) => (y >= 21 ? r : ".".repeat(24)));
  const frames = [1, 2, 3, 4, 5, 6].map((f) => (f === 4 ? RUN6[4] : RUN6[1]));
  const fake = fakeDocument({
    width: 24, height: 32, frames: 6, tags: [{ name: "walk", from: 1, to: 6 }],
    layers: [
      { name: "near arm", frames: frames.map((r) => cel(armRows(r), "N")) },
      { name: "near leg", frames: frames.map((r) => cel(legRows(r), "N")) },
    ],
  });
  const r = await runTool(findTool("walk_check"), {}, fake);
  const t = r.content[0].text;
  assert.match(t, /^WALK CHECK: errors/);
  assert.match(t, /near arm: layer "near arm"; near leg: layer "near leg" \(stored on the sprite\)/);
  assert.match(t, /frame 1 \(contact\): the near arm and the near leg both swing back/);
  const st = (await fake.request("get_state")).result;
  assert.equal(JSON.parse(st.activeSprite.motion).clips.walk.walk.nearArm.layer, "near arm");
  const again = await runTool(findTool("walk_check"), {}, fake);
  assert.doesNotMatch(again.content[0].text, /stored on the sprite/);
  const noTag = await runTool(findTool("walk_check"), { tag: "run" }, fake);
  assert.match(noTag.content[0].text, /No tag "run"/);
});

/** The run-6 walk on part layers 'near arm' and 'near leg', with a scripted critic (#99 motion review). */
function walkFake(shiftPassing = false) {
  const cel = (rows, keep) => {
    const img = asciiImage(rows.map((r, y) => [...r].map((c) => (c === "N" && keep(y) ? "N" : ".")).join("")));
    return { x: 0, y: 0, width: img.width, height: img.height, data: img.data };
  };
  const shift = (rows) => rows.map((r) => "." + r.slice(0, -1));
  const frames = [1, 2, 3, 4, 5, 6].map((f) => (f === 4 ? RUN6[4] : shiftPassing && (f === 3 || f === 6) ? shift(RUN6[1]) : RUN6[1]));
  return fakeDocument({
    width: 24, height: 32, frames: 6, tags: [{ name: "walk", from: 1, to: 6 }],
    layers: [
      { name: "near arm", frames: frames.map((r) => cel(r, (y) => y >= 11 && y <= 17)) },
      { name: "near leg", frames: frames.map((r) => cel(r, (y) => y >= 21)) },
    ],
  });
}
const rgbaOf = (c) => ({ width: c.width, height: c.height, rgba: Buffer.from(c.data).toString("base64"), x: 0, y: 0 });
const scripted = (reply) => {
  const asked = [];
  return { asked, open: () => ({ ask: async (message, images) => { asked.push({ message, images }); return reply; }, close() {} }) };
};

test("compareMotion: an arm seen with its paired leg, no pairing, or the far limbs read as near are findings (#99)", async () => {
  const { compareMotion, parseMotion } = await import("../dist/critic.js");
  const measured = [
    { frame: 1, arm: { pixels: 9, offset: -2 }, leg: { pixels: 9, offset: 2 } },
    { frame: 4, arm: { pixels: 9, offset: 2 }, leg: { pixels: 9, offset: -2 } },
  ];
  const seen = (a, b) => parseMotion(JSON.stringify({ frames: [{ label: "A", ...a }, { label: "B", ...b }] }));
  assert.deepEqual(compareMotion(measured, seen(
    { arm: "back", same_side_leg: "forward", pairing: "both light" }, { arm: "forward", same_side_leg: "back", pairing: "" })), []);
  const f = compareMotion(measured, seen(
    { arm: "back", same_side_leg: "back", pairing: "the dark arm and the dark leg" },
    { arm: "unclear", same_side_leg: "forward", pairing: "" }));
  assert.match(f[0], /frame 1: a player sees the arm swing back with the leg on its side \(paired by: the dark arm and the dark leg\). Give the near arm and the near leg the same depth cue/);
  assert.match(f[1], /frame 4: a player can't tell which arm goes with which leg/);
  const unsure = compareMotion(measured, seen(
    { arm: "back", same_side_leg: "forward", pairing: "sleeve vs leg value disagree", sure: false }, { arm: "forward", same_side_leg: "back", pairing: "", sure: true }));
  assert.equal(unsure.length, 1);
  assert.match(unsure[0], /frame 1: a player can't tell which arm goes with which leg \(paired by: sleeve vs leg value disagree\)/);
  const far = compareMotion(measured, seen(
    { arm: "forward", same_side_leg: "back", pairing: "" }, { arm: "back", same_side_leg: "forward", pairing: "" }));
  assert.match(far[0], /frame 1: a player reads the far limbs as the near ones \(arm forward, leg back; the near arm is back, the near leg forward\)/);
  assert.throws(() => parseMotion('{"frames": [{"arm": "left", "same_side_leg": "back"}, {}]}'), /arm must be/);
});

test("motion_review: shows a fresh critic the two contacts, blind, and reports measured errors and what it sees (#99)", async () => {
  const fake = walkFake();
  const critic = scripted(JSON.stringify({ frames: [
    { label: "A", arm: "back", same_side_leg: "back", pairing: "" }, { label: "B", arm: "forward", same_side_leg: "forward", pairing: "" }] }));
  const r = await runTool(findTool("motion_review"), {}, { ...fake, critic });
  const t = r.content[0].text;
  assert.match(t, /^MOTION REVIEW: errors/);
  assert.match(t, /walk_check: errors/);
  assert.match(t, /measured: frame 1 \(contact\): the near arm and the near leg both swing back/);
  assert.match(t, /A player sees frame 4: the arm forward, the leg on its side forward/);
  assert.equal(critic.asked.length, 1);
  assert.equal(critic.asked[0].images.length, 1, "one image: the two contacts side by side");
  assert.doesNotMatch(critic.asked[0].message, /near arm" layer|offset|walk_check|measured/i, "blind to the measurement");
  assert.match(critic.asked[0].message, /faces right/);
  const none = await runTool(findTool("motion_review"), {}, fake);
  assert.match(none.content[0].text, /critic is not available/);
});

test("walk_check: a near leg not clearly lighter than the far leg is an error (#99 depth cue)", async () => {
  const { judgeWalk, legLightness, limbMask, fromTop, MIN_DEPTH } = await import("../dist/walk_check.js");
  // The benchmark runs' legs: near #3c3c5a (L 0.37) against far #1d2b53 (L 0.30), then a lighter near leg #6a6a90.
  const legs = (near) => {
    const rows = RUN6[1].map((r, y) => (y >= 21 ? r : ".".repeat(24)));
    const img = asciiImage(rows);
    // In RUN6 'N' is one leg, 'g' the other: call g the near leg here.
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] === 60 && img.data[i + 1] === 60) img.data.set(near, i);
      else if (img.data[i] === 29) img.data.set([0x1d, 0x2b, 0x53], i);
    }
    return img;
  };
  const weak = legs([0x3c, 0x3c, 0x5a]);
  const sel = { colors: ["#3c3c5a"], rows: [21, 30] };
  const l1 = legLightness(weak, fromTop(limbMask(weak, sel), 24));
  assert.ok(l1.near - l1.far < MIN_DEPTH, JSON.stringify(l1));
  const leg = { pixels: 9, offset: 2 }, arm = { pixels: 9, offset: -2 };
  const v = judgeWalk([{ frame: 1, arm, leg, legLight: l1 }, { frame: 4, arm: { pixels: 9, offset: 2 }, leg: { pixels: 9, offset: -2 } }]);
  assert.equal(v.status, "errors");
  assert.match(v.errors[0], /frame 1: the near leg \(lightness 0.37\) isn't clearly lighter than the far leg \(0.3\)/);
  const strong = legs([0x6a, 0x6a, 0x90]);
  const l2 = legLightness(strong, fromTop(limbMask(strong, { colors: ["#6a6a90"], rows: [21, 30] }), 24));
  assert.ok(l2.near - l2.far >= MIN_DEPTH, JSON.stringify(l2));
  assert.equal(judgeWalk([{ frame: 1, arm, leg, legLight: l2 }, { frame: 4, arm: { pixels: 9, offset: 2 }, leg: { pixels: 9, offset: -2 } }]).status, "ok");
  assert.equal(legLightness(asciiImage(RUN6[1].map(() => ".".repeat(24))), new Array(24 * 32).fill(false)), undefined);
});

test("motion_clip plan: a walk's keys stage, then advance only with every key drawn and walk_check ok (#99, #109)", async () => {
  const fake = walkFake(true);
  const run = (input) => runTool(findTool("motion_clip"), input, fake);
  assert.match((await run({})).content[0].text, /No motion clip or rig/);
  const start = await run({ action: "plan" });
  assert.match(start.content[0].text, /Clip "walk" \(frames 1-6, 600 ms, loops\): walk, facing right; stage "keys"/);
  assert.match(start.content[0].text, /keys 1, 3, 4, 6; contacts 1, 4/);
  assert.match(start.content[0].text, /Draw the key frames 1, 3, 4, 6 now. Edits to frames 2, 5 are undone until motion_clip advance \(walk_check must say ok on the contacts first\)/);
  const store = async () => JSON.parse((await fake.request("get_state")).result.activeSprite.motion);
  const clip = (await store()).clips.walk;
  assert.deepEqual(clip.keys, [{ at: 1 }, { at: 3 }, { at: 4 }, { at: 6 }]);
  assert.equal(clip.stage, "keys");
  // The run-6 contacts: same-side swing, so advance is refused.
  const refused = await run({ action: "advance" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Not yet: walk_check says errors/);
  assert.equal((await store()).clips.walk.stage, "keys");
  assert.match((await run({ action: "plan", tag: "run" })).content[0].text, /No tag "run"/);
});

test("motion_clip advance and done: empty keys, holds, and every frame drawn and distinct (#109)", async () => {
  const empty = fakeDocument({ width: 8, height: 8, frames: 6, tags: [{ name: "walk", from: 1, to: 6 }], layers: [{ name: "Art", frames: [] }] });
  await runTool(findTool("motion_clip"), { action: "plan" }, empty);
  const r = await runTool(findTool("motion_clip"), { action: "advance" }, empty);
  assert.match(r.content[0].text, /Key frames 1, 3, 4, 6 have no art yet/);

  // An idle on frames 2-5 (frame 1 is a base pose outside the tag): keys tag-relative, same pose twice only as a hold.
  const dot = (x) => { const d = new Uint8Array(8 * 8 * 4); d.set([255, 0, 0, 255], (2 * 8 + x) * 4); return { x: 0, y: 0, width: 8, height: 8, data: d }; };
  const idle = fakeDocument({ width: 8, height: 8, frames: 5, tags: [{ name: "idle", from: 2, to: 5 }],
    layers: [{ name: "Art", frames: [dot(0), dot(1), undefined, dot(1), undefined] }] });
  const run = (input) => runTool(findTool("motion_clip"), input, idle);
  const s = await run({ action: "plan", tag: "idle" });
  assert.match(s.content[0].text, /idle, facing right; stage "keys"/);
  assert.match(s.content[0].text, /Draw the key frames 2, 4 now/);
  assert.doesNotMatch(s.content[0].text, /walk_check/);
  assert.match((await run({ action: "advance" })).content[0].text, /Key frame 4 repeats the key before: draw a different pose, or plan it with hold: true/);
  await run({ action: "plan", tag: "idle", keys: [2, { frame: 4, pose: "breath held", hold: true }] });
  const a = await run({ action: "advance" });
  assert.equal(a.isError, undefined, a.content[0].text);
  assert.match(a.content[0].text, /Clip "idle" is in stage "inbetweens"/);
  assert.match((await run({ action: "done" })).content[0].text, /Not done: frames 3, 5 of "idle" have no art/);
  await idle.request("put_images", { images: [3, 5].map((f) => ({ ...rgbaOf(dot(f === 3 ? 1 : 3)), frame: f, layer: "Art" })) });
  assert.match((await run({ action: "done" })).content[0].text, /Not done: frames 3, 4 repeat the frame before. A held pose is one frame with a longer duration/);
  await idle.request("put_images", { images: [{ ...rgbaOf(dot(2)), frame: 3, layer: "Art" }] });
  assert.match((await run({ action: "done" })).content[0].text, /Clip "idle" is done/);
  const shown = (await run({})).content[0].text;
  assert.match(shown, /keys 2, 4 \(breath held\) hold/);
  assert.match(shown, /stage "done"/);
});

test("motion_clip rig: parents from names, joints suggested from pixels and marked derived (#109)", async () => {
  const img = (pts) => { const d = new Uint8Array(12 * 12 * 4); for (const [x, y] of pts) d.set([200, 0, 0, 255], (y * 12 + x) * 4); return { x: 0, y: 0, width: 12, height: 12, data: d }; };
  const torso = []; for (let y = 2; y <= 7; y++) for (let x = 4; x <= 6; x++) torso.push([x, y]);
  const arm = [[7, 3], [8, 4], [9, 5], [10, 6]];
  const fake = fakeDocument({ width: 12, height: 12, frames: 1, layers: [{ name: "torso", frames: [img(torso)] }, { name: "near arm", frames: [img(arm)] }] });
  const r = await runTool(findTool("motion_clip"), { action: "rig", character: "Knight", parts: [{ layer: "torso" }, { layer: "near arm" }] }, fake);
  const t = r.content[0].text;
  assert.match(t, /Rig "Knight" \(base frame 1\)/);
  assert.match(t, /near arm <- torso: joint 7,3, end 10,6, length 4.2 \[derived\]/);
  assert.match(t, /check them on a snapshot of the base frame/);
  const set = await runTool(findTool("motion_clip"), { action: "rig", character: "Knight", parts: [{ layer: "torso" }, { layer: "near arm", joint: [7, 2], end: [10, 6] }] }, fake);
  assert.match(set.content[0].text, /near arm <- torso: joint 7,2, end 10,6, length 5 \[set\]/);
  assert.match((await runTool(findTool("motion_clip"), { action: "rig", parts: [{ layer: "cape" }] }, fake)).content[0].text, /No image layer "cape"/);
});

test("motion store: migrates the pixel spec's motion and walk, rejects a newer version, keeps frames tag-relative (#109)", async () => {
  const { MotionStore, parseMotion, defaultKeys } = await import("../dist/motion_clip.js");
  const { documentOf } = await import("../dist/document.js");
  assert.deepEqual(defaultKeys("walk", 6), [1, 3, 4, 6]);
  assert.deepEqual(defaultKeys("walk", 8), [1, 3, 5, 7]);
  assert.deepEqual(defaultKeys("action", 5), [1, 3]);
  assert.throws(() => parseMotion(JSON.stringify({ version: 2, rigs: {}, clips: {} })), /version 2; this bridge reads version 1/);
  assert.throws(() => parseMotion(JSON.stringify({ version: 1, rigs: {}, clips: { walk: { kind: "fly" } } })), /malformed: clips.walk/);
  const fake = fakeDocument({ width: 8, height: 8, frames: 8, tags: [{ name: "walk", from: 3, to: 8 }], layers: [{ name: "Art", frames: [] }] });
  await fake.request("put_images", { images: [],
    spec: JSON.stringify({ motion: { tag: "walk", keys: [3, 5, 6, 8], stage: "inbetweens", walk: true }, walk: { tag: "walk", facing: "left", contacts: [3, 6], nearArm: { layer: "A" }, nearLeg: { layer: "L" } } }) });
  const store = await MotionStore.load(documentOf(fake));
  const v = store.view("walk");
  assert.deepEqual(v.clip.keys.map((k) => k.at), [1, 3, 4, 6]);
  assert.deepEqual(v.keys, [3, 5, 6, 8]);
  assert.deepEqual(v.contacts, [3, 6]);
  assert.equal(v.clip.stage, "inbetweens");
  assert.deepEqual(store.walkContract("walk"), { tag: "walk", facing: "left", contacts: [3, 6], nearArm: { layer: "A" }, nearLeg: { layer: "L" } });
  assert.equal(await store.save("migrate"), true);
  assert.equal(JSON.parse((await fake.request("get_state")).result.activeSprite.motion).clips.walk.keys[0].at, 1);
});

test("judgeCycle: a walk needs a bob that is low on the contacts, and near limbs that keep their size", () => {
  const flat = [1, 2, 3, 4, 5, 6].map((frame) => ({ frame, top: 4, arm: 10, leg: 12 }));
  assert.match(judgeCycle(flat, [1, 4]).errors.join(" "), /no bob/);
  const wrong = flat.map((c) => ({ ...c, top: c.frame === 1 || c.frame === 4 ? 3 : 4 }));
  assert.match(judgeCycle(wrong, [1, 4]).errors.join(" "), /highest on the contact frames 1, 4/);
  const good = flat.map((c) => ({ ...c, top: c.frame === 3 || c.frame === 6 ? 3 : 4 }));
  assert.deepEqual(judgeCycle(good, [1, 4]).errors, []);
  const redrawn = good.map((c) => ({ ...c, leg: c.frame === 2 ? 25 : 12 }));
  assert.match(judgeCycle(redrawn, [1, 4]).errors.join(" "), /near leg changes size .*12 px in frame 1, 25 px in frame 2/);
});
