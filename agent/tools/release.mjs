#!/usr/bin/env node
// Releases the current commit to the user's stable channel (docs/INSTANCES.md):
// moves the `stable` branch on origin to HEAD and tags it stable-<date>-<n>,
// with the commit subjects since the last release as the tag message. Run it
// only after the unit, Lua and related live tests passed on the dev instance.
//   node agent/tools/release.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { REPO } from "./instances.mjs";

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
const dry = process.argv.includes("--dry-run");
if (git("status", "--porcelain")) throw new Error("The working tree has changes: commit them first");
const head = git("rev-parse", "HEAD");
git("fetch", "--quiet", "origin");
let previous;
try {
  previous = git("rev-parse", "origin/stable");
} catch {
  previous = undefined;
}
if (previous === head) {
  console.log("stable is already at HEAD");
  process.exit(0);
}
const notes = git("log", "--format=- %s", previous ? `${previous}..${head}` : "-n10", ...(previous ? [] : [head]));
const day = new Date().toISOString().slice(0, 10);
const taken = git("tag", "--list", `stable-${day}-*`).split("\n").filter(Boolean).length;
const tag = `stable-${day}-${taken + 1}`;
console.log(`${dry ? "Would release" : "Releasing"} ${head.slice(0, 9)} as ${tag}:\n${notes}`);
if (!dry) {
  git("tag", "-a", tag, "-m", `${tag}\n\n${notes}`, head);
  git("push", "--quiet", "origin", `${head}:refs/heads/stable`, `refs/tags/${tag}`);
  console.log("done");
}
