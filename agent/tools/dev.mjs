#!/usr/bin/env node
// The agent's dev instance of Aseprite (tools/instances.mjs), apart from the
// user's stable one: its own user folder and agent home.
//   node agent/tools/dev.mjs install    link agent/extension into the dev user folder
//   node agent/tools/dev.mjs start      start the dev Aseprite (build/bin/aseprite)
//   node agent/tools/dev.mjs stop       stop it (only the one this script started)
//   node agent/tools/dev.mjs restart    install, stop, start
//   node agent/tools/dev.mjs env        print the dev environment (to start a bridge by hand)
import { DEV, installExtension, instanceEnv, launch, stop } from "./instances.mjs";

const cmd = process.argv[2] ?? "restart";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (cmd === "install" || cmd === "restart") {
  const r = installExtension(DEV);
  console.log(`linked ${r.files} files into ${r.dest}`);
}
if (cmd === "stop" || cmd === "restart") {
  if (stop(DEV)) { console.log("stopped the dev Aseprite"); await sleep(1500); }
}
if (cmd === "start" || cmd === "restart") console.log(`started the dev Aseprite (pid ${launch(DEV)})`);
if (cmd === "env") for (const [k, v] of Object.entries(instanceEnv(DEV))) console.log(`${k}=${v}`);
if (!["install", "start", "stop", "restart", "env"].includes(cmd)) {
  console.error("usage: dev.mjs install|start|stop|restart|env");
  process.exit(2);
}
