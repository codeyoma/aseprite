// Live test of chats per sprite: each sprite has its own chats, a sprite can
// have several, switching tabs shows that sprite's chats, the running
// chat's tool requests wait while its sprite isn't the active tab, and a
// message for another chat waits for the running turn.
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

// 3) A turn on Alpha waits while Beta is the active tab.
// A fresh chat: Codex keeps an Ask turn's read-only stance in the same conversation.
const gateChat = await lua("return AsepriteAgent.newChat()");
await submit("Add a new empty layer named Gate to this sprite, then reply DONE.", "agent");
await whenBusy();
await show("Beta");
let waited = false;
for (let i = 0; i < 60 && !waited; i++) {
  await sleep(500);
  waited = await lua(`return AsepriteAgent.isBusy() and true or false`) && (await layers("Alpha")).indexOf("Gate") < 0;
  if (waited && i < 10) waited = false; // give the agent time to reach its first tool call
}
check("Beta never gets the layer", !(await layers("Beta")).includes("Gate"));
check("Alpha has no layer yet while Beta is active", !(await layers("Alpha")).includes("Gate"), await layers("Alpha"));
await show("Alpha");
await waitIdle();
const gateLog = (await lua("return AsepriteAgent.entries()")).slice(-12).map((e) => `${e.kind}:${(e.text ?? "").slice(0, 160)}`);
check("back on Alpha, the turn finishes there", (await layers("Alpha")).includes("Gate"), { layers: await layers("Alpha"), log: gateLog });
check("and Beta stays untouched", !(await layers("Beta")).includes("Gate"));

// 4) A message for another chat waits for the running turn.
await lua(`AsepriteAgent.showChat(${JSON.stringify(first)}) return true`);
await submit("Count slowly from 1 to 25, one number per line.");
await whenBusy();
await lua(`AsepriteAgent.showChat(${JSON.stringify(second)}) return true`);
await submit("Reply with only the word THREE.");
const q = await chats();
check("the other chat's message is queued", q.find((c) => c.id === second)?.queued === 1, q);
await waitIdle();
await sleep(1500);
await waitIdle();
check("it ran after the turn ended", (await bubbles()).some((t) => t.includes("THREE")));
done("CHATS");
