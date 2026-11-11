// Updates for the user's stable instance (tools/stable.mjs, docs/INSTANCES.md):
// the panel's "Check for Updates" asks update.check; update.prepare fetches
// and builds the new version beside the running app; update.install starts
// the installer, which waits for Aseprite to quit, puts the new version in
// place and starts it again.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { log } from "./aseprite.js";
import { sessionDir } from "./session.js";

/** tools/stable.mjs of the checkout this bridge runs from. */
export function stableScript(bridgeFile = fileURLToPath(import.meta.url)): string {
  return resolve(dirname(bridgeFile), "..", "..", "tools", "stable.mjs");
}

/** Whether this bridge is the stable instance's (it runs from the stable source, with the stable agent home). */
async function isStable(script: string): Promise<boolean> {
  const { STABLE } = await import(pathToFileURL(join(dirname(script), "instances.mjs")).href);
  return resolve(sessionDir) === resolve(STABLE.home) && resolve(script).startsWith(resolve(STABLE.src));
}

/** Runs `node stable.mjs <args>` and returns its JSON output. */
function runStable(script: string, args: string[]): Promise<any> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => { err += d; log(String(d).trim()); });
    p.on("close", (code) => {
      if (code !== 0) return fail(new Error(err.trim().split("\n").pop() || `stable.mjs ${args[0]} failed`));
      try {
        ok(out.trim() ? JSON.parse(out) : {});
      } catch {
        ok({ output: out.trim() });
      }
    });
  });
}

export function updateMethods(script = stableScript()): Record<string, (params: any) => unknown> {
  const guard = async () => {
    if (!existsSync(script)) throw new Error("tools/stable.mjs is missing next to this bridge");
    if (!(await isStable(script))) throw new Error("This is the dev instance: updates are for the stable install (see docs/INSTANCES.md)");
  };
  return {
    "update.check": async () => {
      await guard();
      return runStable(script, ["check"]);
    },
    "update.prepare": async () => {
      await guard();
      return runStable(script, ["prepare"]);
    },
    // The installer outlives this bridge and Aseprite: it waits for Aseprite to quit.
    "update.install": async () => {
      await guard();
      spawn(process.execPath, [script, "install", "--wait", "--start"], { detached: true, stdio: "ignore" }).unref();
      return { started: true };
    },
  };
}
