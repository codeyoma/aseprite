#!/usr/bin/env node
// The user's stable instance (tools/instances.mjs): built from the `stable`
// branch in its own folder (~/.aseprite-agent-stable), never from the working
// checkout. Builds stay on this machine (the Aseprite EULA forbids
// distributing them).
//
//   node agent/tools/stable.mjs check             what `stable` has that the install lacks (JSON)
//   node agent/tools/stable.mjs prepare           fetch and build the new version beside the running app
//   node agent/tools/stable.mjs install           put the prepared version in place (Aseprite must be closed)
//   node agent/tools/stable.mjs update            prepare + install
//   node agent/tools/stable.mjs start             start the stable Aseprite
//   node agent/tools/stable.mjs launcher          (macOS) make ~/Applications/Aseprite AI.app
//   --wait-for <pid>   (install, update) wait until that process exits first
//   --wait             (install, update) wait until the running stable Aseprite exits
//   --start            (install, update) start the stable Aseprite afterwards
//
// Layout of ~/.aseprite-agent-stable: src/ (a worktree of this repository at
// the `stable` commit, with its build/ inside), app/ (the installed binary and
// data, a copy, so a build never touches the running program), installed.json.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installExtension, IS_WINDOWS, REPO, STABLE } from "./instances.mjs";

const BRANCH = process.env.ASEPRITE_AGENT_STABLE_BRANCH ?? "stable";
const appDir = join(STABLE.root, "app");
const appBin = join(appDir, IS_WINDOWS ? "aseprite.exe" : "aseprite");
const recordFile = join(STABLE.root, "installed.json");
const preparedFile = join(STABLE.root, "prepared.json");
/** The running stable Aseprite's pid, written by start() and the launcher; install waits for it to exit. */
export const pidFile = join(STABLE.home, "aseprite.pid");

const git = (args, cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: IS_WINDOWS });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
const log = (s) => process.stderr.write(`[stable] ${s}\n`);

/** Files that only need the agent layer copied (no C++ build). */
export const agentOnly = (path) => path.startsWith("agent/") || /\.(md|txt)$/i.test(path) && !path.startsWith("src/");

/** What the remote `stable` has compared with the install. */
export function check() {
  git(["fetch", "--quiet", "origin", `${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  const available = git(["rev-parse", `origin/${BRANCH}`]);
  const installed = readJson(recordFile)?.commit;
  if (installed === available) return { installed, available, upToDate: true };
  const range = installed ? `${installed}..${available}` : available;
  const notes = git(["log", "--format=%h %s", "-n", "30", ...(installed ? [range] : [available, "-n", "10"])]).split("\n").filter(Boolean);
  const files = installed ? git(["diff", "--name-only", installed, available]).split("\n").filter(Boolean) : [];
  const needsBuild = !installed || !existsSync(appBin) || files.some((f) => !agentOnly(f));
  return { installed, available, upToDate: false, needsBuild, notes, files: files.length };
}

/** Fetches `stable` into the source worktree and builds what changed; the running app is not touched. */
export function prepare() {
  const c = check();
  if (c.upToDate) return { ...c, prepared: false };
  mkdirSync(STABLE.root, { recursive: true });
  if (!existsSync(join(STABLE.src, ".git"))) {
    log(`making the source worktree in ${STABLE.src}`);
    git(["worktree", "add", "--detach", STABLE.src, c.available]);
  } else {
    git(["checkout", "--quiet", "--detach", c.available], STABLE.src);
  }
  log("updating submodules");
  run("git", ["submodule", "update", "--init", "--recursive"], STABLE.src);
  if (c.needsBuild) {
    log("building Aseprite (the first build takes a while)");
    if (existsSync(join(STABLE.src, "build", "build.ninja"))) run("cmake", ["--build", "build"], STABLE.src);
    // build.cmd loads Visual Studio's environment and ends with `pause`: answer it. `.\`: cmd skips the current
    // folder when NoDefaultCurrentDirectoryInExePath is set.
    else if (IS_WINDOWS) run("cmd", ["/c", "echo.| .\\build.cmd --auto --norun"], STABLE.src);
    else run("./build.sh", ["--auto", "--norun"], STABLE.src);
  }
  log("building the bridge");
  const bridgeDir = join(STABLE.src, "agent", "bridge");
  run("npm", ["ci", "--no-audit", "--no-fund"], bridgeDir);
  run("npm", ["run", "build"], bridgeDir);
  const prepared = { commit: c.available, needsBuild: c.needsBuild, notes: c.notes, at: new Date().toISOString() };
  writeFileSync(preparedFile, JSON.stringify(prepared, null, 2));
  return { ...c, prepared: true };
}

/** Puts the prepared version in place: the binary and data (when rebuilt), the extension, the bridge path. */
export function install() {
  const p = readJson(preparedFile);
  if (!p) throw new Error("Nothing prepared: run prepare first");
  if (p.needsBuild || !existsSync(appBin)) {
    log(`installing the app into ${appDir}`);
    rmSync(appDir, { recursive: true, force: true });
    cpSync(join(STABLE.src, "build", "bin"), appDir, { recursive: true });
  }
  const ext = installExtension(STABLE, { link: false });
  log(`copied ${ext.files} extension files into ${ext.dest}`);
  // The stable extension starts its bridge from here (bridge_connection.lua reads <agent home>/bridge.json).
  mkdirSync(STABLE.home, { recursive: true });
  writeFileSync(join(STABLE.home, "bridge.json"), JSON.stringify({ bridgePath: STABLE.bridge, version: p.commit, pinned: true }, null, 2) + "\n");
  writeFileSync(recordFile, JSON.stringify({ commit: p.commit, at: new Date().toISOString(), notes: p.notes }, null, 2));
  rmSync(preparedFile, { force: true });
  return { installed: p.commit };
}

/**
 * Pids of the running stable Aseprite processes, found by executable path (the pid file goes stale when the app is
 * opened another way). Windows: CIM's Win32_Process (wmic is gone from recent Windows), paths compared without case.
 */
export function runningStable() {
  try {
    if (IS_WINDOWS) {
      const ps = `Get-CimInstance Win32_Process -Filter "Name = 'aseprite.exe'" | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`;
      return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true })
        .split(/\r?\n/).flatMap((line) => {
          const m = line.trim().match(/^(\d+)\s+(.+)$/);
          return m && m[2].toLowerCase() === appBin.toLowerCase() ? [Number(m[1])] : [];
        });
    }
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return m && (m[2] === appBin || m[2].startsWith(appBin + " ")) ? [Number(m[1])] : [];
    });
  } catch {
    return [];
  }
}

/** Starts the stable Aseprite (its default user folder and agent home), unless one is already running. */
export function start() {
  if (!existsSync(appBin)) throw new Error("The stable Aseprite is not installed: run update first");
  const running = runningStable();
  if (running.length) {
    // A second instance would fight the first for the agent bridge.
    console.log(`The stable Aseprite is already running (pid ${running.join(", ")}); not starting another.`);
    return;
  }
  const env = { ...process.env, ASEPRITE_AGENT_HOME: STABLE.home };
  delete env.ASEPRITE_USER_FOLDER;
  const child = spawn(appBin, [], { detached: true, stdio: "ignore", env });
  child.unref();
  mkdirSync(STABLE.home, { recursive: true });
  writeFileSync(pidFile, String(child.pid));
}

/**
 * macOS: /Applications/Aseprite AI.app (where Finder, Launchpad and Spotlight look; ~/Applications when /Applications
 * isn't writable), a small app that starts the stable binary with its own bundle id, so it never opens the dev build.
 */
export function launcher() {
  if (IS_WINDOWS) return windowsShortcut();
  if (process.platform !== "darwin") throw new Error("No launcher on this platform: run `node agent/tools/stable.mjs start`");
  let base = "/Applications";
  try {
    accessSync(base, constants.W_OK);
  } catch {
    base = join(homedir(), "Applications");
  }
  const bundle = join(base, "Aseprite AI.app");
  const app = join(bundle, "Contents");
  mkdirSync(join(app, "MacOS"), { recursive: true });
  mkdirSync(join(app, "Resources"), { recursive: true });
  writeFileSync(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Aseprite AI</string>
  <key>CFBundleIdentifier</key><string>com.codeyoma.aseprite-ai</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundleIconFile</key><string>Aseprite</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  const run = join(app, "MacOS", "run");
  writeFileSync(run, `#!/bin/sh\nexport ASEPRITE_AGENT_HOME="${STABLE.home}"\nunset ASEPRITE_USER_FOLDER\nmkdir -p "${STABLE.home}"\necho $$ > "${pidFile}"\nexec "${appBin}" "$@"\n`, { mode: 0o755 });
  // The icon: the agent's logo (tools/assets/aseprite-ai-icon.png, 1024 px) as an .icns.
  const png = join(REPO, "agent", "tools", "assets", "aseprite-ai-icon.png");
  if (existsSync(png)) {
    const set = join(STABLE.root, "Aseprite.iconset");
    rmSync(set, { recursive: true, force: true });
    mkdirSync(set, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      spawnSync("sips", ["-z", String(size), String(size), png, "--out", join(set, `icon_${size}x${size}.png`)], { stdio: "ignore" });
      spawnSync("sips", ["-z", String(size * 2), String(size * 2), png, "--out", join(set, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
    }
    spawnSync("iconutil", ["-c", "icns", set, "-o", join(app, "Resources", "Aseprite.icns")], { stdio: "ignore" });
    rmSync(set, { recursive: true, force: true });
  }
  // Tell Launch Services and Spotlight about it now.
  spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", bundle]);
  return bundle;
}

/** Windows: a Start menu shortcut "Aseprite AI" to the installed program (it needs no environment: stable uses the defaults). */
function windowsShortcut() {
  const lnk = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Aseprite AI.lnk");
  const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); ` +
    `$s.TargetPath = '${appBin.replace(/'/g, "''")}'; $s.WorkingDirectory = '${appDir.replace(/'/g, "''")}'; $s.Save()`;
  execFileSync("powershell", ["-NoProfile", "-Command", ps]);
  return lnk;
}

/**
 * Windows: a running program can't be opened for writing (EBUSY); waits until the installed one can. Renaming is no
 * test: Windows renames a running program.
 */
async function waitUnlocked(file) {
  for (;;) {
    try {
      closeSync(openSync(file, "r+"));
      return;
    } catch (e) {
      if (e.code === "ENOENT") return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitFor(pid) {
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (process.argv[1] && process.argv[1].endsWith("stable.mjs")) {
  const [cmd, ...rest] = process.argv.slice(2);
  // --wait-for <pid>, or --wait: the pid the stable start wrote.
  const wait = rest.includes("--wait-for") ? Number(rest[rest.indexOf("--wait-for") + 1])
    : rest.includes("--wait") && existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined;
  const thenStart = rest.includes("--start");
  try {
    if (cmd === "check") console.log(JSON.stringify(check(), null, 2));
    else if (cmd === "prepare") console.log(JSON.stringify(prepare(), null, 2));
    else if (cmd === "install" || cmd === "update") {
      if (cmd === "update") prepare();
      if (wait || rest.includes("--wait")) {
        // Every running stable Aseprite, not only the pid file's (it is stale when the app was opened another way).
        for (const pid of new Set([...(wait ? [wait] : []), ...runningStable()])) await waitFor(pid);
        // Windows: and until the program file can be replaced (a process found by no path still holds it).
        if (IS_WINDOWS && existsSync(appBin)) await waitUnlocked(appBin);
      }
      if (existsSync(preparedFile)) console.log(JSON.stringify(install(), null, 2));
      if (thenStart) start();
    } else if (cmd === "start") start();
    else if (cmd === "launcher") console.log(launcher());
    else {
      console.error("usage: stable.mjs check|prepare|install|update|start|launcher [--wait-for <pid>] [--start]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[stable] ${e.message}`);
    process.exit(1);
  }
}
