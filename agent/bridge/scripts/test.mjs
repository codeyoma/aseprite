// npm test, the same on macOS, Linux and Windows: build, check generated
// files, check the extension, check the Lua-tests stamp, then the unit tests
// offline (no network fetches).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The test files, listed here: shells differ in globbing, and older Node takes no directory.
const tests = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);

const steps = [
  ["npm", ["run", "build"]],
  [process.execPath, ["scripts/gen.mjs", "--check"]],
  [process.execPath, ["../tools/check_extension.mjs"]],
  [process.execPath, ["../tools/check_lua_stamp.mjs"]],
  [process.execPath, ["--test", ...tests]],
];
// A throwaway agent home: the tests never write into the user's (~/.aseprite-agent, the stable instance's).
const home = mkdtempSync(join(tmpdir(), "agent-home-"));
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit", shell: process.platform === "win32" && cmd === "npm",
    env: { ...process.env, ASEPRITE_AGENT_OFFLINE: "1", ASEPRITE_AGENT_HOME: home },
  });
  if (r.status !== 0) {
    rmSync(home, { recursive: true, force: true });
    process.exit(r.status ?? 1);
  }
}
rmSync(home, { recursive: true, force: true });
