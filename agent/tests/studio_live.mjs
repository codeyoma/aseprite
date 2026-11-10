// Live test of the brief and studio skills (#78): one request goes through a brief, a chain written as the plan,
// a new 32x32 sprite with a walk cycle, a review and a Godot export, ending with a compromise report.
// Long: the whole chain runs in one turn (allow 45 minutes).
// Run with Aseprite open:  node agent/tests/studio_live.mjs <dir> [claude|codex]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { live } from "./live.mjs";

const dir = process.argv[2];
const provider = process.argv[3] ?? "claude";
if (!dir) throw new Error("usage: studio_live.mjs <dir> [claude|codex]");
const { lua, chat, check, soft, ranSkill, done } = await live({ provider });

// A fresh conversation and an empty workspace, so nothing from an earlier run can be reused.
await lua(`AsepriteAgent.newChat() for i = #app.sprites, 1, -1 do app.sprites[i]:close() end return true`);
const spritesBefore = 0;
await chat(`/skill:studio make a 32x32 knight with a walk cycle for Godot. Export the Godot files to ${dir}.`, { timeout: 45 * 60_000 });
await ranSkill("studio");

const entries = (await lua("return AsepriteAgent.entries()")) ?? [];
const turn = entries.slice(entries.map((e) => e.kind).lastIndexOf("user") + 1);
const texts = turn.filter((e) => e.kind === "text").map((e) => e.text ?? "");
const steps = turn.filter((e) => e.kind === "tool").map((e) => e.text ?? "");

// The brief: the first reply states the six decisions (destination: Godot).
const first = texts[0] ?? "";
// Size may be stated as dimensions ("32x32 canvas") rather than the word.
const has = (w) => w === "size" ? /\bsize\b|\b\d+\s*[x×]\s*\d+\b/i.test(first) : first.toLowerCase().includes(w);
const missing = ["size", "palette", "view", "light", "outline", "godot"].filter((w) => !has(w));
check("the first reply is a brief with size, palette, view, light, outline and Godot", missing.length === 0, { missing, first: first.slice(0, 400) });
// The chain: written as the plan (the agent's to-do tool), or at least stated as a chain of skills in its text.
const plan = turn.some((e) => e.kind === "plan" && (e.count ?? 0) >= 3);
const skillNames = ["brief", "animate", "shade-sprite", "review", "export-game", "pixel-art", "recipes", "concept", "make-directions"];
const stated = texts.some((t) => /chain/i.test(t) && skillNames.filter((n) => t.includes(n)).length >= 3);
check("the chain is stated (plan or a chain of skills)", plan || stated, { plan, texts: texts.map((t) => t.slice(0, 200)) });
soft("the chain was written as a plan", plan, turn.filter((e) => e.kind === "plan"));
soft("it read a skill with read_guide when it reached it", steps.some((t) => /^Read guide: (animate|export-game|shade-sprite|review|pixel-art|recipes)$/i.test(t.trim())), steps);

// The knight: a 32x32 sprite with at least 4 frames (the walk cycle), new or the one the agent reused.
const made = await lua(`local out = {}
  for _, s in ipairs(app.sprites) do out[#out + 1] = { w = s.width, h = s.height, frames = #s.frames, active = s == app.sprite } end
  return { sprites = out, before = ${spritesBefore} }`);
const knight = (made?.sprites ?? []).find((s) => s.w === 32 && s.h === 32 && s.frames >= 4);
check("a 32x32 sprite with at least 4 frames", !!knight, made);

// The Godot export in the folder we named.
const files = existsSync(dir) ? readdirSync(dir) : [];
const tres = files.find((f) => f.endsWith(".tres"));
check("Godot files exported: a sheet PNG and a SpriteFrames .tres", files.some((f) => f.endsWith(".png")) && !!tres, files);
if (tres) soft("the SpriteFrames has a walk animation", /walk/i.test(readFileSync(join(dir, tres), "utf8")), tres);

// Model choices: a review ran, and the turn ends with a compromise report.
soft("the review ran (a fresh critic was asked)", steps.some((t) => /^Ask a fresh critic/.test(t.trim())), steps);
const last = texts.at(-1) ?? "";
soft("it ends with a compromise report", /compromis|approximat|cut\b|skipped|left out/i.test(last), last.slice(0, 600));
done("STUDIO");
