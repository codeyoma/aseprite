// palette_swap (#48): variants go on 'AI: <name>' layers in one undo step, and the
// variants' new colors join the sprite palette, so check sees no off-palette pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTool, runTool } from "../dist/tools.js";
import { fakeDocument, rect } from "./helpers/fake_document.mjs";

const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("palette_swap: variant layers in every frame, new colors added to the palette", async () => {
  const shirt = rect(8, 8, [2, 2, 5, 5], [41, 120, 255]);
  const fake = fakeDocument({
    width: 8, height: 8, frames: 2, palette: ["#000000", "#2978ff"], layer: "Hero",
    layers: [{ name: "Hero", frames: [shirt, shirt] }],
  });
  const r = await runTool(findTool("palette_swap"), {
    variants: [{ name: "red team", map: { "#2978ff": "#e8283c" } }, { name: "green team", map: { "#2978ff": "#2fb84a" } }],
  }, fake);
  assert.ok(!r.isError, textOf(r));
  assert.equal(fake.calls.filter((c) => c.method === "put_images").length, 1, "one undo step");
  for (const [name, rgb] of [["AI: red team", [232, 40, 60]], ["AI: green team", [47, 184, 74]]]) {
    const ims = fake.images(name);
    assert.equal(ims.filter(Boolean).length, 2, `${name}: both frames`);
    const i = (3 * 8 + 3) * 4;
    assert.deepEqual([...ims[1].slice(i, i + 3)], rgb, name);
  }
  const pal = (await fake.request("get_palette", {})).result.colors;
  for (const h of ["#e8283c", "#2fb84a"]) assert.ok(pal.includes(h), `${h} in ${pal}`);
});
