// Live test of the Skill Catalog's / picker (#35): typing "/query" lists
// matching skills, picking one fills "/skill:name ", and the reply header
// names the skill. Run with Aseprite open:  node agent/tests/skills_picker_live.mjs [claude|codex]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
// A user skill that needs a selection (#58).
const userSkills = mkdtempSync(join(tmpdir(), "skills-"));
mkdirSync(join(userSkills, "select-test"));
writeFileSync(join(userSkills, "select-test", "SKILL.md"), "---\nname: select-test\ntitle: Selection test\ndescription: Needs a selection.\ncategory: Test\nneeds: [selection]\n---\nSay ok.\n");
const { lua, chat, sleep, check, done } = await live({ provider, bridge: { env: { ASEPRITE_AGENT_SKILLS: userSkills } } });
const names = (list) => (list ?? []).map((s) => s.name);

await lua(`local s = Sprite(16, 16) for i = 1, 3 do s:newFrame() end AsepriteAgent.openPanel() AsepriteAgent.typePrompt("/") return true`);
await sleep(1500); // the catalog arrives from the bridge
await lua(`AsepriteAgent.typePrompt("/") return true`);
const all = await lua("return AsepriteAgent.suggestions()");
check("/ lists the built-in skills", ["check-sprite", "retime-animation", "make-variations", "parallel-frames"].every((n) => names(all).includes(n)), names(all));
const cats = (all ?? []).filter((s) => s.kind !== "command").map((s) => s.category ?? "Other");
check("a bare / groups skills by category", cats.every((c, i) => i === 0 || cats[i - 1] <= c), cats);
const headers = async () => (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "header").length;
const before = await headers();
await chat("/skill:select-test go", { wait: false });
check("a skill that needs a selection waits for one", (await headers()) === before && !(await lua("return AsepriteAgent.isBusy()")));
await lua(`AsepriteAgent.typePrompt("/ret") return true`);
const ret = await lua("return AsepriteAgent.suggestions()");
check("typing filters", names(ret)[0] === "retime-animation" && !names(ret).includes("make-variations"), names(ret));
await lua(`AsepriteAgent.pickSuggestion(1) return true`);
check("picking fills /skill:name", (await lua("return AsepriteAgent.promptText()")) === "/skill:retime-animation ");

await chat("/skill:retime-animation make it play at 5 fps");
const entries = await lua("return AsepriteAgent.entries()");
const header = entries.filter((e) => e.kind === "header").at(-1)?.text;
check("the header names the skill", header?.endsWith("Retime an animation"), header);
const dur = await lua("local o = {} for _, f in ipairs(app.sprite.frames) do o[#o + 1] = f.duration end return o");
check("the skill did the job", dur.every((d) => Math.abs(d - 0.2) < 0.001), dur);
const tools = entries.filter((e) => e.kind === "tool").map((e) => e.text);
check("it used the timeline tools", tools.some((t) => /timeline/i.test(t)), tools);

done("PICKER");
