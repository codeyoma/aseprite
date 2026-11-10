// make-ui: a 4-state button with a 9-patch slice, in the sprite palette; then a text label.
import { colorsOf, fakeWithColors, textOf } from "./_helpers.mjs";

const PICO = ["#000000", "#1d2b53", "#29adff", "#fff1e8", "#83769c", "#c2c3c7"];

export default {
  skill: "make-ui",
  fixture: () => fakeWithColors({ width: 48, height: 16, palette: PICO, layers: [{ name: "BG", frames: [new Uint8Array(48 * 16 * 4)] }] }),
  steps: [
    { tool: "make_ui", input: { kind: "button", width: 48, height: 16, fill: "#29adff", label: "Play", name: "play" } },
    { tool: "draw_text", input: { text: "HI", x: 2, y: 2, color: "#fff1e8" } },
  ],
  check(fake, results, assert) {
    assert.match(textOf(results[0]), /48x16 button with normal, hover, pressed and disabled frames/);
    const s = fake.active.sprite;
    assert.deepEqual([s.width, s.height, s.durations.length], [48, 16, 4]);
    assert.deepEqual(s.tags.map((t) => t.name), ["normal", "hover", "pressed", "disabled"]);
    assert.equal(s.slices?.length, 1);
    assert.equal(s.slices[0].name, "play");
    assert.deepEqual(s.slices[0].center, { x: 2, y: 2, w: 44, h: 12 });
    const button = s.layers[0].cels;
    for (const [i, f] of button.entries()) for (const c of colorsOf(f)) assert.ok(PICO.includes(c), `frame ${i + 1}: ${c} is not in the palette`);
    assert.ok(!Buffer.from(button[0]).equals(Buffer.from(button[2])), "pressed differs from normal");
    const label = fake.cel("AI: text");
    assert.deepEqual([...colorsOf(label)], ["#fff1e8"]);
  },
};
