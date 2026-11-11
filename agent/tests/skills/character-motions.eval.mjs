// character-motions: ask how finely to split the character, append a motion after the base pose with its tag, and
// generate the motion's frames per part layer (one image per layer holding both frames), cut into those frames.
import { join } from "node:path";
import { fakeDocument, tempDir, textOf, writePng } from "./_helpers.mjs";

const dir = tempDir("motions");
/** A 200x200 sheet, 2x2 grid: pose 1 and 2 with a torso (blue) and/or an arm (red) at the arm's x. */
function sheet(name, { torso = true, arm = true } = {}) {
  const W = 200, data = new Uint8Array(W * W * 4).fill(255);
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data.set([...c, 255], (y * W + x) * 4); };
  for (const [px, armX] of [[0, 60], [100, 25]]) {
    if (torso) rect(px + 35, 30, px + 64, 95, [40, 90, 220]);
    if (arm) rect(px + armX, 40, px + armX + 9, 70, [220, 40, 40]);
  }
  const path = join(dir, `${name}.png`);
  writePng(path, { width: W, height: W, data });
  return path;
}

export default {
  skill: "character-motions",
  fixture() {
    const paths = { master: sheet("master"), torso: sheet("torso", { arm: false }), arm: sheet("arm", { torso: false }) };
    // The base pose on frame 1 and the attack appended as frames 2-3 (apply_timeline_text runs in the extension).
    const fake = fakeDocument({ width: 20, height: 20, frames: 3, tags: [{ name: "attack", from: 2, to: 3 }], layers: [{ name: "Base", frames: [undefined] }],
      extra: { execute_lua: () => ({ ok: true }) } });
    fake.posted = [];
    fake.post = (ev) => fake.posted.push(ev);
    fake.ask = async () => true;
    return import("../../bridge/dist/image_gen.js").then(({ ImageJobs }) => {
      fake.images = new ImageJobs({ async generate(prompt) {
        const path = prompt.includes("ONLY the torso") ? paths.torso : prompt.includes("ONLY the arm") ? paths.arm : paths.master;
        return { path, width: 200, height: 200 };
      } });
      return fake;
    });
  },
  steps: [
    { tool: "ask_user", input: { question: "How finely should I split the knight into layers?", options: ["8 rough layers", "Detailed"] } },
    { tool: "generate_character", input: {
      subject: "a knight", poses: ["wind-up", "slash"], frames: [2, 3], tag: "attack", name: "Knight",
      layers: [{ name: "torso", part: "the torso" }, { name: "near arm", part: "the arm" }],
    } },
  ],
  check(fake, results, assert) {
    assert.equal(fake.posted[0]?.type, "question", "the question went to the chat");
    assert.match(textOf(results[0]), /End your turn now/);
    const tag = fake.active.sprite.tags.find((t) => t.name === "attack");
    assert.ok(tag, "the motion has its tag");
    assert.match(textOf(results[1]), /Put "Knight" on frames 2, 3/);
    assert.ok(fake.cel("AI: torso", 2) && fake.cel("AI: torso", 3), "the torso layer has both frames");
    assert.ok(!fake.cel("AI: torso", 1), "the base frame is left alone");
  },
};
