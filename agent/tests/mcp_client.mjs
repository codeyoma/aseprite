// Minimal MCP stdio client used by the smoke test and the demos.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// ASEPRITE_AGENT_BRIDGE overrides the bridge entry, e.g. to test an installed package.
export const bridgePath = process.env.ASEPRITE_AGENT_BRIDGE ?? join(here, "../bridge/dist/index.js");

export async function startBridge({ args = [], env = {} } = {}) {
  // Tests call tools directly, so they see every tool (#88: agents get the core set and reach the rest by call_tool).
  const proc = spawn("node", [bridgePath, ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ASEPRITE_AGENT_TOOLS: "all", ...process.env, ...env } });
  let buf = "";
  const waiters = new Map();
  proc.stdout.on("data", (d) => {
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
  const rpc = (method, params) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => waiters.set(id, resolve));
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const listTools = async () => (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  const stop = () => proc.kill();
  return { proc, rpc, call, listTools, stop };
}

export const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
export const imageOf = (r) => {
  const img = r.content.find((c) => c.type === "image");
  return img ? Buffer.from(img.data, "base64") : null;
};

/** Poll get_state until Aseprite connects. */
export async function waitForAseprite(client, seconds = 60) {
  for (let t = 0; t < seconds; t += 3) {
    const r = await client.call("get_state");
    if (!r.isError) return JSON.parse(textOf(r));
  }
  throw new Error("Aseprite did not connect");
}
