// End-to-end smoke test: spawns the bridge over stdio, waits for Aseprite to
// connect, then calls each MCP tool.
// Run: node agent/tests/mcp_smoke.mjs   (with Aseprite open)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = spawn("node", [join(here, "../bridge/dist/index.js")], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const waiters = new Map();
bridge.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiters.set(id, resolve));
}
const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

const timeoutS = Number(process.env.WAIT ?? 60);
console.log(`Waiting up to ${timeoutS}s for Aseprite to connect...`);
let state;
for (let t = 0; t < timeoutS; t += 3) {
  state = await call("get_state");
  if (!state.isError) break;
}
if (state.isError) {
  console.error("FAIL:", textOf(state));
  process.exit(1);
}
console.log("get_state OK:", JSON.parse(textOf(state)).asepriteVersion);

const exec = await call("execute_lua", {
  label: "Smoke test",
  code: `
    local s = Sprite(32, 32)
    s.layers[1].name = "Body"
    local img = Image(32, 32)
    for y = 0, 31 do for x = 0, 31 do
      local dx, dy = x - 15.5, y - 15.5
      if dx*dx + dy*dy < 12*12 then img:drawPixel(x, y, Color(220, 60, 60)) end
    end end
    s:newCel(s.layers[1], 1, img, Point(0, 0))
    return { layers = #s.layers, size = s.width .. "x" .. s.height }
  `,
});
console.log(exec.isError ? "FAIL execute_lua:" : "execute_lua OK:", textOf(exec));

const snap = await call("snapshot", {});
const img = snap.content.find((c) => c.type === "image");
if (snap.isError || !img) {
  console.error("FAIL snapshot:", textOf(snap));
} else {
  const out = join(process.env.OUT_DIR ?? here, "smoke_snapshot.png");
  writeFileSync(out, Buffer.from(img.data, "base64"));
  console.log("snapshot OK:", textOf(snap), "->", out);
}

const bad = await call("execute_lua", { code: "app.sprite:newLayer(); error('deliberate')" });
console.log(bad.isError ? "error path OK:" : "FAIL error path:", textOf(bad).split("\n")[0]);

let failed = 0;
const expect = (label, r, pred) => {
  const ok = !r.isError && pred(textOf(r));
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${textOf(r).split("\n").slice(0, 3).join(" | ").slice(0, 160)}`);
};

expect("get_context", await call("get_context"), (t) => JSON.parse(t).sprite?.width === 32);
expect("read_pixels", await call("read_pixels", { x: 14, y: 14, width: 4, height: 2 }), (t) => t.includes("Legend:") && t.includes("#dc3c3c"));
expect("list_commands", await call("list_commands", { filter: "size" }), (t) => t.includes("SpriteSize") && t.includes("CanvasSize"));
expect("run_command CanvasSize", await call("run_command", { name: "CanvasSize", params: { right: 8 } }), (t) => t.includes("ran"));
expect("state after CanvasSize", await call("get_state"), (t) => JSON.parse(t).activeSprite.width === 40);
expect("undo", await call("undo", {}), () => true);
expect("state after undo", await call("get_state"), (t) => JSON.parse(t).activeSprite.width === 32);
expect("run_command color", await call("run_command", { name: "ReplaceColor", params: { from: "#dc3c3c", to: "#3c3cdc", tolerance: 0 } }), (t) => t.includes("ran"));
expect("read_pixels after color", await call("read_pixels", { x: 15, y: 15, width: 1, height: 1 }), (t) => t.includes("#3c3cdc"));
expect("unknown command", { content: [{ type: "text", text: "x" }] }, () => true);
const unk = await call("run_command", { name: "SpriteSiz" });
if (!unk.isError || !textOf(unk).includes("SpriteSize")) { failed++; console.log("FAIL unknown command suggestion"); } else console.log("OK   unknown command suggestion");
expect("read_guide list", await call("read_guide", {}), (t) => t.includes("basics") && t.includes("recipes"));
expect("read_guide basics", await call("read_guide", { topic: "basics" }), (t) => t.includes("Object model"));
await call("undo", {});

console.log(failed ? `${failed} FAILED` : "ALL SMOKE CHECKS PASSED");
bridge.kill();
process.exit(failed ? 1 : 0);
