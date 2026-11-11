// Live test of project memory and checkpoints (#93): a saved sprite's chat works in the sprite's folder and creates
// AGENTS.md there; the agent proposes a style memory entry that the user approves (stored on the sprite, shown in
// the State block); each Agent turn saves a checkpoint; rewinding restores the sprite through the undo history,
// restores the conversation (the message goes back in the box), and branches into a new chat on a copy in a new tab.
// Run with Aseprite open:  node agent/tests/memory_live.mjs [claude|codex]
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, chat, check, soft, done } = await live({ provider });

const dir = mkdtempSync(join(tmpdir(), "memory-live-"));
const file = join(dir, "slime.aseprite");
await lua(`local s = Sprite(32, 32, ColorMode.RGB) s.layers[1].name = "Slime"
  local img = Image(32, 32, ColorMode.RGB)
  for y = 16, 28 do for x = 8, 23 do img:drawPixel(x, y, Color(60, 200, 90)) end end
  s.layers[1]:cel(1).image = img
  s:saveAs(${JSON.stringify(file)}) return true`);
const newChat = await lua("return AsepriteAgent.newChat()");
check("a fresh chat for the sprite", typeof newChat === "string", newChat);

const pixels = () => lua(`local s = app.sprite local n = 0
  for _, cel in ipairs(s.cels) do for it in cel.image:pixels() do if it() ~= 0 then n = n + 1 end end end
  return { layers = #s.layers, opaque = n, file = s.filename }`);
const entries = () => lua("return AsepriteAgent.entries()");

// 1. The agent proposes a style memory entry; the user approves it.
await chat("We'll always use a 1 px dark green (#14502a) selout outline on this project. Propose that as style memory with remember_style, then stop without drawing.", { timeout: 300_000 });
const proposal = (await entries()).filter((e) => e.kind === "memory").at(-1);
check("a style memory card appeared", !!proposal, (await entries()).map((e) => e.kind));
soft("its topic is outline", proposal?.topic === "outline", proposal);
check("approving it", await lua("return AsepriteAgent.answerMemory(1)"));
const memory = await lua("return AsepriteAgent.styleMemory()");
check("stored on the sprite", Array.isArray(memory) && memory.length === 1, memory);
check("AGENTS.md was created in the sprite's folder", existsSync(join(dir, "AGENTS.md")), readdirSync(dir));

// 2. A drawing turn takes a checkpoint first.
const before = await pixels();
await chat("Add a new layer named Eyes with two 2x2 black eyes on the slime, then stop.", { timeout: 600_000 });
const after = await pixels();
check("the agent drew", after.layers > before.layers || after.opaque !== before.opaque, { before, after });
const users = (await entries()).filter((e) => e.kind === "user");
check("the drawing message has a checkpoint", users.at(-1)?.checkpoint === true, users.at(-1));
const md = readFileSync(join(dir, "AGENTS.md"), "utf8");
check("AGENTS.md mirrors the style memory", /- outline: /.test(md), md);

// 3. Restore the sprite to before the drawing message: back through the undo history.
check("restore sprite", await lua(`return AsepriteAgent.rewind(${users.length}, "sprite")`));
const restored = await pixels();
check("the sprite is as it was before the message", restored.layers === before.layers && restored.opaque === before.opaque, { before, restored });
check("redo brings the work back", (await lua(`local s = app.sprite local n = 0
  for i = 1, 50 do app.command.Redo() end return #s.layers`)) === after.layers);

// 4. Restore the conversation: the message goes back into the box.
check("restore conversation", await lua(`return AsepriteAgent.rewind(${users.length}, "conversation")`));
const kept = (await entries()).filter((e) => e.kind === "user");
check("the message and its reply are gone", kept.length === users.length - 1, kept.map((e) => e.text));
check("the message is back in the prompt box", /Eyes/.test((await lua("return AsepriteAgent.promptText()")) ?? ""));

// 5. The next message continues with a recap in a new agent session.
await lua(`AsepriteAgent.setPrompt("") return true`);
await chat("What outline rule did we agree on? Answer in one sentence and do not change anything.", { mode: "ask", timeout: 300_000 });
const reply = (await entries()).filter((e) => e.kind === "text").at(-1)?.text ?? "";
soft("the agent remembers the outline rule (recap or State block)", /selout|outline/i.test(reply), reply);

// 6. Branch from the first message: a new chat on a copy in a new tab.
const tabsBefore = await lua("return #app.sprites");
check("branch from here", await lua(`return AsepriteAgent.rewind(1, "branch")`));
check("the copy opened as a new tab", (await lua("return #app.sprites")) === tabsBefore + 1);
const branchFile = (await pixels()).file;
check("the copy has its own name next to the original", branchFile.startsWith(dir) && branchFile !== file, branchFile);
const chats = await lua("return AsepriteAgent.chats()");
check("the branch chat is shown", chats.some((c) => c.current && /branch/.test(c.title ?? "")), chats);
check("the checkpoints folder has files", (await lua(`local n = 0
  local root = app.fs.joinPath(os.getenv("ASEPRITE_AGENT_HOME") or app.fs.joinPath(os.getenv("HOME"), ".aseprite-agent"), "checkpoints")
  for _, d in ipairs(app.fs.listFiles(root)) do n = n + #app.fs.listFiles(app.fs.joinPath(root, d)) end return n`)) > 0);
done("MEMORY");
