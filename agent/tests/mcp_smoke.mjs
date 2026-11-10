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

bridge.kill();
process.exit(0);
