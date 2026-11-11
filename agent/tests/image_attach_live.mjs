// Live test of image attachments in other formats: an animated GIF (a red
// ball moving right over 6 frames, the last held longer) and a BMP (a blue
// square) are attached in the panel; the agent must say what each shows. The
// bridge turns the GIF into a numbered sheet of frames and the BMP into a PNG.
// Run with Aseprite open:  node agent/tests/image_attach_live.mjs <scratch dir> [claude|codex]
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
const { lua, chat, check, soft, done } = await live({ provider });

// Aseprite writes the files: a 6-frame GIF and a one-frame BMP.
const gif = join(dir, "ball.gif"), bmp = join(dir, "square.bmp");
await lua(`
  local s = Sprite(24, 24, ColorMode.RGB)
  for f = 1, 6 do
    if f > 1 then s:newEmptyFrame() end
    local img = Image(24, 24, ColorMode.RGB)
    for y = 8, 15 do for x = 1 + (f - 1) * 3, 8 + (f - 1) * 3 do img:drawPixel(x, y, Color(220, 40, 40)) end end
    s:newCel(s.layers[1], f, img, Point(0, 0))
    s.frames[f].duration = f == 6 and 0.4 or 0.1
  end
  s:saveCopyAs(${JSON.stringify(gif)})
  s:close()
  local q = Sprite(40, 40, ColorMode.RGB)
  app.useTool{ tool = "filled_rectangle", color = Color(30, 60, 230), points = { Point(8, 8), Point(31, 31) } }
  q:saveCopyAs(${JSON.stringify(bmp)})
  q:close()
  return true`);
check("files written", spawnSync("test", ["-s", gif]).status === 0 && spawnSync("test", ["-s", bmp]).status === 0);

await lua(`Sprite(16, 16)
  AsepriteAgent.attach{ path = ${JSON.stringify(gif)} }
  AsepriteAgent.attach{ path = ${JSON.stringify(bmp)} }
  return true`);
await chat("Look only at the two attached images. Answer in one line each: " +
  "1) how many frames the first one has, which way the shape moves, and which frame lasts longest; " +
  "2) the color and shape in the second one.", { mode: "ask" });

const reply = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "text").map((e) => e.text).join(" ");
const errors = (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "error").map((e) => e.text);
check("no error in the panel", errors.length === 0, errors);
check("the GIF's frame count (6)", /\b6\b|six/i.test(reply), reply.slice(0, 400));
check("the ball moves right", /right/i.test(reply), reply.slice(0, 400));
soft("the last frame is the longest", /(frame )?6\b[^.]*(long|400)|(long|400)[^.]*\b6\b|last/i.test(reply), reply.slice(0, 400));
check("the BMP's blue square", /blue/i.test(reply) && /square|rectangle/i.test(reply), reply.slice(0, 400));

// The clipboard image (macOS: osascript puts the BMP's PNG copy there), attached and cleared again.
if (process.platform === "darwin") {
  const png = join(dir, "square.png");
  await lua(`local q = Sprite{ fromFile = ${JSON.stringify(bmp)} } q:saveCopyAs(${JSON.stringify(png)}) q:close() return true`);
  const set = spawnSync("osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as «class PNGf»)`]);
  check("clipboard set", set.status === 0, String(set.stderr));
  const c = await lua(`local ok = AsepriteAgent.attach("clipboard")
    local p = AsepriteAgent.pendingAttachments()
    AsepriteAgent.clearAttachments()
    return { ok = ok, label = p[1] and p[1].label or "", after = #AsepriteAgent.pendingAttachments() }`);
  check("the clipboard image is attached, then cleared", c.ok && c.label === "pasted image 40x40" && c.after === 0, c);
}
done("IMAGE ATTACH");
