// Live test of chats per sprite: each sprite has its own chats, a sprite can
// have several, switching tabs shows that sprite's chats, the running
// chats work at the same time, each on its own sprite, whichever tab is
// active (#90).
// Run with Aseprite open:  node agent/tests/chats_live.mjs [claude|codex]
import { live } from "./live.mjs";

const provider = process.argv[2] ?? "claude";
const { lua, waitIdle, check, done } = await live({ provider });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const submit = (text, mode = "ask") => lua(`AsepriteAgent.chat(${JSON.stringify(text)}, ${JSON.stringify(provider)}, ${JSON.stringify(mode)}) return true`);
const chats = () => lua("return AsepriteAgent.chats()");
const bubbles = async () => (await lua("return AsepriteAgent.entries()")).filter((e) => e.kind === "user").map((e) => e.text);
const busy = () => lua("return AsepriteAgent.isBusy()");
const whenBusy = async () => { for (let i = 0; i < 40 && !(await busy()); i++) await sleep(250); };
const show = (name) => lua(`for _, s in ipairs(app.sprites) do if app.fs.fileTitle(s.filename) == "${name}" then app.sprite = s end end return true`);
const layers = (name) => lua(`for _, s in ipairs(app.sprites) do if app.fs.fileTitle(s.filename) == "${name}" then
  local o = {} for _, l in ipairs(s.layers) do o[#o + 1] = l.name end return o end end return {}`);

await lua(`for i = #app.sprites, 1, -1 do app.sprites[i]:close() end
  local a = Sprite(16, 16) a.filename = "Alpha"
  local b = Sprite(16, 16) b.filename = "Beta"
  app.sprite = a return true`);

// 1) Alpha's first chat, then a second chat on Alpha.
await submit("Reply with only the word ONE.");
await waitIdle();
const first = await lua("return AsepriteAgent.currentChat()");
const second = await lua("return AsepriteAgent.newChat()");
const c1 = await chats();
check("Alpha has two chats, the new one shown and empty", c1.length === 2 && c1[1].current && c1[1].entries === 0, c1);
await submit("Reply with only the word TWO.");
await waitIdle();
check("the second chat has its own messages", (await bubbles()).join() === "Reply with only the word TWO.");
await lua(`AsepriteAgent.showChat(${JSON.stringify(first)}) return true`);
check("switching back shows the first chat", (await bubbles()).join() === "Reply with only the word ONE.");

// 2) Beta has its own chats.
await show("Beta");
await sleep(300);
const b = await chats();
check("Beta shows its own, empty chat", b.length === 1 && b[0].entries === 0 && b[0].id !== first && b[0].id !== second, b);
await show("Alpha");
await sleep(300);
check("Alpha's chats are back", (await chats()).length === 2);

// 3) Two chats work at the same time, each on its own sprite, while a third
//    sprite is the active tab (#90). Each edit lands on its chat's sprite.
await lua(`local g = Sprite(16, 16) g.filename = "Gamma" return true`);
await show("Alpha");
await sleep(300);
const alphaChat = await lua("return AsepriteAgent.newChat()");
await submit("Add a new empty layer named Gate to this sprite, then reply DONE.", "agent");
await show("Beta");
await sleep(300);
const betaChat = await lua("return AsepriteAgent.newChat()");
await submit("Add a new empty layer named Gate to this sprite, then reply DONE.", "agent");
await show("Gamma");
await sleep(500);
let both = false;
for (let i = 0; i < 40 && !both; i++) {
  const busy = await lua("return AsepriteAgent.busyChats()");
  both = Array.isArray(busy) && busy.includes(alphaChat) && busy.includes(betaChat);
  if (!both) await sleep(250);
}
check("a chat works while another does", both);
await waitIdle();
check("Alpha got its layer", (await layers("Alpha")).includes("Gate"), await layers("Alpha"));
check("Beta got its layer", (await layers("Beta")).includes("Gate"), await layers("Beta"));
check("Gamma, the active tab, untouched", !(await layers("Gamma")).includes("Gate"), await layers("Gamma"));
check("the active tab is still Gamma", (await lua("return app.fs.fileTitle(app.sprite.filename)")) === "Gamma");
await lua(`AsepriteAgent.showChat(${JSON.stringify(alphaChat)}) return true`);
check("Alpha's chat stayed on Alpha", (await chats()).some((c) => c.id === alphaChat));

// 4) Two chats on the same sprite at once: both edits land, and neither reply
//    offers Revert (its undo range holds the other chat's steps too).
await show("Beta");
await sleep(300);
const one = await lua("return AsepriteAgent.newChat()");
await submit("Add a new empty layer named One to this sprite, then reply DONE.", "agent");
const two = await lua("return AsepriteAgent.newChat()");
await submit("Add a new empty layer named Two to this sprite, then reply DONE.", "agent");
await waitIdle();
const beta = await layers("Beta");
check("both same-sprite edits landed", beta.includes("One") && beta.includes("Two"), beta);
const views = [];
for (const id of [one, two]) {
  await lua(`AsepriteAgent.showChat(${JSON.stringify(id)}) return true`);
  views.push(await lua("return AsepriteAgent.lastTurnView()"));
}
const overlapped = (await lua("return true")) && views.some((v) => v.action !== "revert");
check("a reply mixed with another chat's edits offers no Revert", overlapped, views);

done("CHATS");
