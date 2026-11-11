// Live test: a chat's unsent draft survives switching sprites (and chats),
// including the switch the panel makes when the active sprite changes.
// Run with the dev Aseprite open:  node agent/tests/draft_live.mjs
import { live } from "./live.mjs";

const { lua, check, done } = await live({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prompt = () => lua("return AsepriteAgent.promptText and AsepriteAgent.promptText() or ''");
const show = (name) => lua(`for _, s in ipairs(app.sprites) do if app.fs.fileTitle(s.filename) == "${name}" then app.sprite = s end end return true`);

await lua(`for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
  local a = Sprite(8, 8) a.filename = "DraftA"
  local b = Sprite(8, 8) b.filename = "DraftB"
  app.sprite = a
  return true`);
await lua("AsepriteAgent.openPanel() AsepriteAgent.typePrompt(\"\") return true");
await sleep(300);
await lua(`AsepriteAgent.typePrompt("half-typed request for A") return true`);
check("the draft is in the box", (await prompt()) === "half-typed request for A", await prompt());
await show("DraftB");
await sleep(300);
check("B's chat shows its own (empty) draft", (await prompt()) === "", await prompt());
await lua(`AsepriteAgent.typePrompt("note for B") return true`);
await show("DraftA");
await sleep(300);
check("back on A, A's draft is still there", (await prompt()) === "half-typed request for A", await prompt());
await show("DraftB");
await sleep(300);
check("and B's too", (await prompt()) === "note for B", await prompt());
await lua("AsepriteAgent.closePanel() return true");
await sleep(300);
await lua("AsepriteAgent.openPanel() return true");
await sleep(300);
check("closing and opening the panel keeps the draft", (await prompt()) === "note for B", await prompt());
const id = await lua("return AsepriteAgent.newChat()");
check("a new chat starts empty", (await prompt()) === "", id);
done("DRAFT");
