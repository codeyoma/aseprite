// Live test of the writable pixel grid (#74): the agent fixes a 3-pixel defect (three stray red pixels in a
// flat blue square), then read_pixels -> write_pixels is called directly (no model): a round trip changes
// nothing and a write is one undo step.
// Run with Aseprite open:  node agent/tests/pixel_grid_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { c, lua, chat, check, soft, done } = await live({ provider });

// A 16x16 RGB sprite with its own palette: a dark outline around a flat blue square (layer Body), and three
// stray red pixels inside it. `expected` is the same sprite without the strays.
const OUTLINE = "#1a1030", BODY = "#3c78c8", STRAY = "#e03c3c";
const STRAYS = [[6, 6], [9, 7], [7, 10]];
const fixture = `local s = Sprite(16, 16, ColorMode.RGB) s.layers[1].name = "Body"
  local pal = Palette(4) pal:setColor(0, Color(0, 0, 0, 0)) pal:setColor(1, Color(0x1a, 0x10, 0x30))
  pal:setColor(2, Color(0x3c, 0x78, 0xc8)) pal:setColor(3, Color(0xe0, 0x3c, 0x3c)) s:setPalette(pal)
  local img = Image(16, 16, ColorMode.RGB)
  for y = 3, 12 do for x = 3, 12 do
    local edge = x == 3 or y == 3 or x == 12 or y == 12
    img:drawPixel(x, y, edge and Color(0x1a, 0x10, 0x30) or Color(0x3c, 0x78, 0xc8))
  end end
  for _, p in ipairs(${JSON.stringify(STRAYS).replace(/\[/g, "{").replace(/\]/g, "}")}) do img:drawPixel(p[1], p[2], Color(0xe0, 0x3c, 0x3c)) end
  s.layers[1]:cel(1).image = img
  app.frame = s.frames[1] app.layer = s.layers[1] return true`;
// The Body layer as 16 rows of '.', 'o' (outline), 'b' (body), 'r' (stray) or '?' (anything else).
const rowsOf = () => lua(`local s = app.sprite local l = s.layers[1] local cel = l:cel(1) local rows = {}
  local keys = { ["${OUTLINE}"] = "o", ["${BODY}"] = "b", ["${STRAY}"] = "r" }
  for y = 0, s.height - 1 do
    local row = {}
    for x = 0, s.width - 1 do
      local k = "."
      if cel then
        local ix, iy = x - cel.position.x, y - cel.position.y
        if ix >= 0 and iy >= 0 and ix < cel.image.width and iy < cel.image.height then
          local v = cel.image:getPixel(ix, iy)
          local pc = app.pixelColor
          if pc.rgbaA(v) > 0 then k = keys[string.format("#%02x%02x%02x", pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v))] or "?" end
        end
      end
      row[#row + 1] = k
    end
    rows[#rows + 1] = table.concat(row)
  end
  return rows`);
const expected = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => {
  if (x < 3 || y < 3 || x > 12 || y > 12) return ".";
  return x === 3 || y === 3 || x === 12 || y === 12 ? "o" : "b";
}).join(""));
const diff = (got) => got.flatMap((row, y) => [...row].flatMap((k, x) => (k === expected[y][x] ? [] : [`${x},${y}:${k}`])));

await lua(fixture);
const before = await rowsOf();
check("the fixture has exactly the 3 stray pixels", diff(before).length === 3 && STRAYS.every(([x, y]) => before[y][x] === "r"), diff(before));
await chat("The blue square on layer Body has 3 stray red pixels. Fix those 3 pixels so the square is one flat blue, and change nothing else.");
const after = await rowsOf();
check("the defect is gone and nothing else changed", diff(after).length === 0, diff(after));
const entries = await lua("return AsepriteAgent.entries()");
const lastUser = entries.map((e) => e.kind === "user").lastIndexOf(true);
const tools = entries.slice(lastUser).filter((e) => e.kind === "tool");
const wrote = tools.filter((e) => /write_pixels|Write .*pixel/i.test(`${e.name ?? ""} ${e.text ?? ""}`));
soft("it used write_pixels", wrote.length > 0, tools.map((e) => e.name ?? e.text));
soft("write_pixels succeeded the first time", wrote.length > 0 && wrote[0].status === "ok", wrote.map((e) => e.status));
soft("no execute_lua for the fix", !tools.some((e) => /execute_lua|Run Lua/i.test(`${e.name ?? ""} ${e.text ?? ""}`)), tools.map((e) => e.name ?? e.text));

// The tools themselves (no model).
await lua(fixture);
const textOf = (r) => (r.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
const read = textOf(await c.call("read_pixels", { layer: "Body", x: 2, y: 2, width: 12, height: 12 })).split("\n");
const legend = read[1];
const rows = read.slice(2);
const same = textOf(await c.call("write_pixels", { layer: "Body", x: 2, y: 2, rows, legend }));
check("writing the read rows back changes nothing", /: 0 of 144 pixels changed/.test(same), same);
// Every stray key replaced by the body's key, as an agent would.
const keyOf = (hex) => legend.match(new RegExp(`(\\S+)=${hex}`))?.[1];
const bodyKey = keyOf(BODY), strayKey = keyOf(STRAY);
const fixed = rows.map((r) => r.replace(/^(\s*\d+\|\s?)(.*)$/, (_, label, body) => label + body.split(" ").map((k) => (k === strayKey ? bodyKey : k)).join(" ")));
const res = textOf(await c.call("write_pixels", { layer: "Body", x: 2, y: 2, rows: fixed, legend }));
check("the fix through the tool changes exactly 3 pixels", /: 3 of 144 pixels changed/.test(res), res);
check("the tool's fix matches the expected image", diff(await rowsOf()).length === 0, diff(await rowsOf()));
await lua(`app.command.Undo() return true`);
check("one undo brings the strays back", diff(await rowsOf()).length === 3, diff(await rowsOf()));
const ragged = await c.call("write_pixels", { layer: "Body", rows: [". .", "."], legend: "" });
check("a ragged grid is refused with its row", ragged.isError === true && /Row 2 \(y=1\)/.test(textOf(ragged)), textOf(ragged));
done("PIXEL GRID");
