#!/usr/bin/env node
// Headless runner benchmark (#85): snapshots of 20 small generated .aseprite
// files, once through one long-lived runner (`ase --headless snapshot`, run
// in-process through the CLI's runHeadlessMode) and
// once as 20 separate `aseprite -b` runs (each loading the Document Handlers
// and taking one snapshot, like `ase check <file>` does). Prints both times.
//
//   ASEPRITE=build/bin/aseprite node agent/tests/headless_bench.mjs [count]
//
// Needs the bridge built (cd agent/bridge && npm run build). The files are
// fresh temp files, so the live window cannot have them open: the run skips
// asking the live bridge (an older live bridge cannot answer and would refuse).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extension");
const cli = join(here, "..", "bridge", "dist", "cli.js");
const bin = process.env.ASEPRITE ?? join(here, "..", "..", "build", "bin", "aseprite");
const count = Number(process.argv[2] ?? 20);
if (!existsSync(bin)) {
  console.error(`No Aseprite at ${bin} (set ASEPRITE)`);
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error("Build the bridge first: cd agent/bridge && npm run build");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "ase-bench-"));
const lua = (name, code) => {
  const path = join(dir, name);
  writeFileSync(path, code);
  return path;
};

/** n small sprites (32x32, 2 layers, 4 frames) in one batch run. */
const make = lua("make.lua", `
for i = 1, tonumber(app.params.n) do
  local s = Sprite(32, 32)
  local top = s:newLayer()
  for f = 2, 4 do s:newFrame() end
  for f = 1, 4 do
    local img = Image(32, 32)
    for y = 0, 31 do for x = 0, 31 do
      if (x + y + i + f) % 5 == 0 then img:drawPixel(x, y, Color(i * 12 % 256, x * 8, y * 8)) end
    end end
    s:newCel(top, f, img, Point(0, 0))
  end
  s:saveAs(app.fs.joinPath(app.params.dir, string.format("sprite%02d.aseprite", i)))
  s:close()
end`);
const made = spawnSync(bin, ["-b", "--script-param", `dir=${dir}`, "--script-param", `n=${count}`, "--script", make], { encoding: "utf8" });
if (made.status !== 0) throw new Error(made.stderr || made.stdout);
const files = readdirSync(dir).filter((f) => f.endsWith(".aseprite")).sort().map((f) => join(dir, f));

// One process per file: open, load the handlers, snapshot frame 1.
const single = lua("single.lua", `
local P = (function() local f = assert(io.open(app.fs.joinPath(app.params.ext, "protocol.json"))); local p = json.decode(f:read("a")); f:close(); return p end)()
local H = dofile(app.fs.joinPath(app.params.ext, "document_handlers.lua")).new{ chunkDir = app.params.ext, protocol = P }
local header, bytes = H.call("snapshot", { frame = 1 })
local out = assert(io.open(app.params.out, "wb")); out:write(bytes); out:close()
print("ok", header.width, header.height)`);

const t0 = performance.now();
for (const f of files) {
  const r = spawnSync(bin, ["-b", f, "--script-param", `ext=${ext}`, "--script-param", `out=${f}.rgba`, "--script", single], { encoding: "utf8" });
  if (r.status !== 0 || !/^ok/m.test(r.stdout)) throw new Error(`separate run failed for ${f}: ${r.stderr || r.stdout}`);
}
const separate = performance.now() - t0;

const outDir = join(dir, "out");
process.env.ASEPRITE_BIN = bin;
const { parseArgs, runHeadlessMode } = await import(pathToFileURL(cli).href);
const t1 = performance.now();
await runHeadlessMode(parseArgs(["--headless", "snapshot", ...files, "-o", outDir + "/"]), { liveFiles: async () => [] });
const batch = performance.now() - t1;
const pngs = readdirSync(outDir).filter((f) => f.endsWith(".png")).length;
if (pngs !== files.length) throw new Error(`expected ${files.length} snapshots, got ${pngs}`);

rmSync(dir, { recursive: true, force: true });
const ms = (x) => `${Math.round(x)} ms`;
console.log(`${files.length} snapshots`);
console.log(`  separate aseprite -b runs: ${ms(separate)} (${ms(separate / files.length)} each)`);
console.log(`  one headless runner (ase --headless snapshot): ${ms(batch)} (${ms(batch / files.length)} each, startup included)`);
console.log(`  speedup: ${(separate / batch).toFixed(1)}x`);
if (batch >= separate) {
  console.log("FAIL the headless batch is not faster");
  process.exit(1);
}
console.log("PASS the headless batch is faster");
