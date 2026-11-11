// npm test, the same on macOS, Linux and Windows: build, check generated
// files, check the extension, check the Lua-tests stamp, then the unit tests
// offline (no network fetches).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// The test files, listed here: shells differ in globbing, and older Node takes no directory.
const tests = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);

const steps = [
  ["npm", ["run", "build"]],
  [process.execPath, ["scripts/gen.mjs", "--check"]],
  [process.execPath, ["../tools/check_extension.mjs"]],
  [process.execPath, ["../tools/check_lua_stamp.mjs"]],
  [process.execPath, ["--test", ...tests]],
];
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit", shell: process.platform === "win32" && cmd === "npm",
    env: { ...process.env, ASEPRITE_AGENT_OFFLINE: "1" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
