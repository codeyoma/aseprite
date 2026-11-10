// The Lua-tests stamp: a hash of the extension sources (agent/extension/*.lua
// and protocol.json) recorded after a full passing run of
// agent/tests/run_lua_tests.sh, in the gitignored agent/tests/.lua-tests-passed.
//
//   node agent/tools/check_lua_stamp.mjs          warn when the extension changed
//                                                 since the last passing Lua run
//   node agent/tools/check_lua_stamp.mjs --write  record the stamp (run_lua_tests.sh)
//
// CI has no Aseprite build (EULA), so a stale stamp is only a warning; with
// ASEPRITE_AGENT_REQUIRE_LUA=1 (the pre-push hook, tools/pre-push.sh) it fails.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agent = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(agent, "extension");
const stampFile = join(agent, "tests", ".lua-tests-passed");

function extensionHash() {
  const names = readdirSync(ext).filter((n) => n.endsWith(".lua") || n === "protocol.json").sort();
  const h = createHash("sha256");
  for (const n of names) {
    h.update(n + "\0");
    h.update(readFileSync(join(ext, n)));
    h.update("\0");
  }
  return h.digest("hex");
}

const hash = extensionHash();
if (process.argv.includes("--write")) {
  writeFileSync(stampFile, hash + "\n");
  console.log(`wrote Lua-tests stamp ${hash.slice(0, 12)} -> agent/tests/.lua-tests-passed`);
  process.exit(0);
}

const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : undefined;
if (stamp === hash) {
  console.log("Lua tests: ok (stamp matches agent/extension)");
  process.exit(0);
}
const why = stamp === undefined ? "no passing Lua run is recorded" : "agent/extension changed since the last passing Lua run";
const required = process.env.ASEPRITE_AGENT_REQUIRE_LUA === "1";
console.error(
  `${required ? "ERROR" : "WARNING"}: Lua tests: ${why}.\n` +
    `  Run: ASEPRITE=<aseprite binary> agent/tests/run_lua_tests.sh   (writes agent/tests/.lua-tests-passed)`,
);
process.exit(required ? 1 : 0);
