// Live test of concept-first (#79): a synthetic 4-panel storyboard (a figure walking right) becomes reference
// frames on a locked layer, and the agent draws a 4-frame 32x32 animation that follows it.
// Run with Aseprite open:  node agent/tests/concept_live.mjs [scratch dir] [claude|codex]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "../bridge/node_modules/pngjs/lib/png.js";
import { live } from "./live.mjs";

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "concept-live-"));
const provider = process.argv[3] ?? "claude";
const { lua, chat: send, waitIdle, check, soft, ranSkill, done } = await live({ provider });

// Four 128x128 panels on white, one row. In panel i a figure (outline, red tunic, skin head, two legs) stands with
// its feet on y 116, 16 px further right each panel; at 32x32 its center moves 4 px a frame.
const P = 128, W = P * 4, H = P, png = new PNG({ width: W, height: H });
for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 255, 255, 255], i);
const fill = (x0, y0, x1, y1, c) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) png.data.set([...c, 255], (y * W + x) * 4);
};
const OUT = [24, 20, 37], TUNIC = [200, 40, 60], SKIN = [250, 210, 170];
for (let p = 0; p < 4; p++) {
  const x = p * P + 24 + 16 * p;
  fill(x + 6, 36, x + 25, 59, OUT); fill(x + 9, 39, x + 22, 56, SKIN); // head
  fill(x, 60, x + 31, 99, OUT); fill(x + 3, 63, x + 28, 96, TUNIC); // body
  const stride = p % 2 ? 4 : 10; // legs apart on contact frames, together when passing
  fill(x + 16 - stride - 6, 100, x + 16 - stride, 116, OUT);
  fill(x + 16 + stride, 100, x + 16 + stride + 6, 116, OUT);
}
const board = join(dir, "storyboard.png");
writeFileSync(board, PNG.sync.write(png));

await lua(`Sprite(32, 32, ColorMode.RGB) AsepriteAgent.attach{ path = ${JSON.stringify(board)} } return true`);
const headers = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length;
const prompt = `/skill:concept turn this storyboard into a 4 frame 32x32 animation (the image is attached; its file is ${board}). ` +
  "It has 4 panels in one row, one per frame. Don't ask anything, draw it.";
await send(prompt, { wait: false });
const sent = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length > headers;
check("the message reached the panel", sent);
if (sent) await waitIdle();
await ranSkill("concept");

// Per layer: name, locked, visible, and per frame the bounds of its opaque pixels.
const s = await lua(`local s = app.sprite local out = { frames = #s.frames, w = s.width, h = s.height, layers = {} }
  for _, l in ipairs(s.layers) do
    if l.isImage then
      local item = { name = l.name, editable = l.isEditable, visible = l.isVisible, boxes = {} }
      for f = 1, #s.frames do
        local cel = l:cel(f)
        local b = cel and cel.image:shrinkBounds()
        if b and not b.isEmpty then
          item.boxes[tostring(f)] = { x0 = cel.position.x + b.x, y0 = cel.position.y + b.y,
            x1 = cel.position.x + b.x + b.width - 1, y1 = cel.position.y + b.y + b.height - 1 }
        end
      end
      out.layers[#out.layers + 1] = item
    end
  end
  return out`);
const box = (l, f) => l.boxes?.[String(f)];
const ref = s.layers.find((l) => /reference/i.test(l.name));
check("a Reference layer exists", !!ref, s.layers.map((l) => l.name));
check("the sprite has 4 frames", s.frames === 4, s.frames);
check("the Reference layer has a panel on each of the 4 frames", !!ref && [1, 2, 3, 4].every((f) => box(ref, f)), ref);
check("the Reference layer is locked", ref?.editable === false, ref);

// The drawn frames: every other image layer, unioned per frame.
const art = s.layers.filter((l) => l !== ref);
const union = (f) => {
  const bs = art.map((l) => box(l, f)).filter(Boolean);
  if (!bs.length) return undefined;
  return { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) };
};
const center = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const drawn = [1, 2, 3, 4].map(union);
check("the drawn layer has art on all 4 frames", drawn.every(Boolean), drawn);
const offsets = [1, 2, 3, 4].map((f) => {
  const r = ref && box(ref, f), d = drawn[f - 1];
  if (!r || !d) return undefined;
  const [rx, ry] = center(r), [dx, dy] = center(d);
  return { frame: f, ref: [rx, ry], art: [dx, dy], dist: Math.hypot(dx - rx, dy - ry) };
});
check("the drawn frames follow the reference: each center within 4 px of its panel's", offsets.every((o) => o && o.dist <= 4), offsets);
soft("the drawn figure moves right across the frames", drawn.every(Boolean) && center(drawn[3])[0] > center(drawn[0])[0] + 4, drawn);
const replies = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").map((e) => e.text).join(" ");
const spec = await lua(`return app.sprite.properties("aseprite-agent")["concept.spec"] or ""`);
soft("a pixel spec is stored on the sprite", typeof spec === "string" && spec.includes("frames"), String(spec).slice(0, 200));
soft("the reply describes the frames", /frame/i.test(replies), replies.slice(0, 300));

done("CONCEPT");
